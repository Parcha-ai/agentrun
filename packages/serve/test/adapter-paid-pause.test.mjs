// A paid call of the agent's own (a web search, a priced MCP call) that the run's cap refuses for room pauses the run as
// main does (cap.ts paidCall, pauses by default: the run's next request is refused in the cap's words): on the runner's one
// ledger the step's refusal goes to the adapter loop's pause (RunLedger.pause, through the call's Ledger), which holds it
// until the call's result is stored and parks the run at its next request with the cap's figures; nothing is sent or
// booked. A person's
// take-over never pauses (adapter-ask-pause.test.mjs).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cap, capRun, rootEntries } from "./adapter-pi-cap-support.mjs";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { paidRequest, parallelSearchFee } = await import("../dist/paid-calls.js");
const { timelineOf } = await import("../dist/timeline/index.js");
const { mcpGateway } = await import("../dist/mcp-gateway.js");
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** The run's own model, free: its requests always fit, so only the paid call meets the cap. */
const FREE = { id: "claude-sonnet-4-5", api: "anthropic-messages", price: { input: 0, output: 0 }, outputCeiling: 8_192 };

/** A run under a cap of `capUsd` whose one tool `pay` makes one paid call (`call()`), then answers: the run's row, its
 *  budget entries, what the tool was answered, and how many times the call's provider was reached. */
async function paidRun(t, capUsd, call) {
  const answered = [];
  const script = [{ call: "pay" }, { say: "done" }];
  const specOf = (sent) => async (claim, run) => {
    const pay = {
      name: "pay",
      replaySafe: false,
      run: async () => {
        const text = await call();
        answered.push(text);
        return text;
      },
    };
    return piAdapterSpec({ script, tools: { pay }, hooks: quiet }, { fetch: scriptedOrigin(script, sent) })(claim, run);
  };
  const runCap = { capUsd, park: (refusal) => cap.parkOf(refusal, capUsd), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf };
  const run = await capRun(t, { script, specOf, cap: runCap, runCap: { capUsd: () => capUsd, modelOf: () => FREE } });
  return { ...run, answered, budgets: await rootEntries(run.server, "agentrun.budget"), rows: timelineOf(await rootEntries(run.server), { settled: true }) };
}

function assertParked({ row, budgets, answered, rows }, capUsd, leastUsd, words) {
  // The run's next model request, refused in the paused call's words through the model proxy, is the cap's refusal (its
  // code carried as a field): no "Model request failed" row (the park says what happened).
  assert.deepEqual(rows.filter((r) => String(r.summary ?? "").startsWith("Model request failed")).map((r) => r.summary), [], JSON.stringify(rows.map((r) => [r.kind, r.summary])));
  assert.match(answered[0] ?? "", words, `the call was refused in the cap's words: ${JSON.stringify(answered)}`);
  assert.equal(row.state, "parked", `the run parked on the refused call: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.equal(budgets.length, 1, `one pause: ${JSON.stringify(budgets)}`);
  assert.equal(budgets[0].pending.cap_usd, capUsd, "at the run's cap");
  assert.ok(budgets[0].pending.least_cap_usd >= leastUsd, `the least cap that sends the call: ${JSON.stringify(budgets[0])}`);
  assert.equal(row.summary, budgets[0].words, "the row says the cap's words");
}

test("a paid web search the run's cap has no room for parks the run at its next request with the cap's figures, nothing sent", async (t) => {
  let reached = 0;
  const search = async () => {
    try {
      const response = await paidRequest(parallelSearchFee(10), async () => (reached++, new Response("{}", { status: 200 })));
      return `searched (${response.status})`;
    } catch (error) {
      return String(error?.message ?? error);
    }
  };
  const run = await paidRun(t, 0.0005, search);
  assertParked(run, 0.0005, 0.001, /could cost up to \$0\.001/);
  assert.equal(reached, 0, "the search was never sent");
});

test("a refused paid call parks the run only once its result is stored: while the harness holds the refusal, the run is not parked and has no pause", async (t) => {
  // The call's refusal held in the tool, its result not stored yet: what a person polling the run reads meanwhile.
  let answeredNow;
  const answeredYet = new Promise((resolve) => (answeredNow = resolve));
  let go;
  const going = new Promise((resolve) => (go = resolve));
  const search = async () => {
    try {
      await paidRequest(parallelSearchFee(10), async () => new Response("{}", { status: 200 }));
      return "searched";
    } catch (error) {
      answeredNow();
      await going;
      return String(error?.message ?? error);
    }
  };
  let during;
  const answered = [];
  const script = [{ call: "pay" }, { say: "done" }];
  const specOf = (sent) => async (claim, run) => piAdapterSpec({ script, tools: { pay: { name: "pay", replaySafe: false, run: async () => { const text = await search(); answered.push(text); return text; } } }, hooks: quiet }, { fetch: scriptedOrigin(script, sent) })(claim, run);
  const runCap = { capUsd: 0.0005, park: (refusal) => cap.parkOf(refusal, 0.0005), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf };
  const run = await capRun(t, {
    script, specOf, cap: runCap, runCap: { capUsd: () => 0.0005, modelOf: () => FREE },
    during: async (server) => {
      await answeredYet;
      during = { state: (await server.runs.get("run-1")).state, budgets: (await rootEntries(server, "agentrun.budget")).length };
      go();
    },
  });
  assert.deepEqual(during, { state: "running", budgets: 0 }, "refused, its result not stored yet: the run is still running, with no pause");
  assert.equal(run.row.state, "parked", "then parked, at the model's next request");
  assert.equal((await rootEntries(run.server, "agentrun.budget")).length, 1, "with one pause");
  assert.match(answered[0] ?? "", /could cost up to \$0\.001/);
});

test("a refused paid call's pending pause is kept on the run's root, and a claim that finds it with no pause after it restores it", async (t) => {
  const { pendingPauseOf } = await import("../dist/runner/adapter-loop.js");
  const { KINDS } = await import("../dist/runner/journal-kinds.js");
  const refusal = { refuse: "Not sent: …", forGood: false };
  assert.deepEqual(pendingPauseOf([{ kind: "pi.user" }, { kind: KINDS.pausePending, data: refusal }, { kind: "pi.tool-result" }]), refusal, "kept, its pause never landed: restored");
  assert.equal(pendingPauseOf([{ kind: KINDS.pausePending, data: refusal }, { kind: KINDS.budget, data: {} }, { kind: KINDS.raise, data: {} }]), undefined, "its pause landed: nothing to restore");
  assert.equal(pendingPauseOf([{ kind: KINDS.pausePending, data: refusal }, { kind: KINDS.end, data: {} }]), undefined, "the run ended after it");
  assert.equal(pendingPauseOf([{ kind: "pi.user" }]), undefined, "none kept");
  // And the refusal is on the root as the call is refused: the run held as above, its root read meanwhile.
  let answeredNow;
  const answeredYet = new Promise((resolve) => (answeredNow = resolve));
  let go;
  const going = new Promise((resolve) => (go = resolve));
  const script = [{ call: "pay" }, { say: "done" }];
  const pay = { name: "pay", replaySafe: false, run: async () => {
    try {
      await paidRequest(parallelSearchFee(10), async () => new Response("{}", { status: 200 }));
      return "searched";
    } catch (error) {
      answeredNow();
      await going;
      return String(error?.message ?? error);
    }
  } };
  const specOf = (sent) => async (claim, run) => piAdapterSpec({ script, tools: { pay }, hooks: quiet }, { fetch: scriptedOrigin(script, sent) })(claim, run);
  let kept;
  await capRun(t, {
    script, specOf, cap: { capUsd: 0.0005, park: (r) => cap.parkOf(r, 0.0005), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf }, runCap: { capUsd: () => 0.0005, modelOf: () => FREE },
    during: async (server) => {
      await answeredYet;
      kept = pendingPauseOf(await rootEntries(server));
      go();
    },
  });
  assert.match(kept?.refuse ?? "", /could cost up to \$0\.001/, `the refusal kept on the root before the call's result: ${JSON.stringify(kept)}`);
});

test("a priced MCP call the run's cap has no room for parks the run at its next request with the cap's figures, nothing sent", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "adapter-paid-pause-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  // Never reached: the call is refused before it leaves, so no server listens at this address.
  const url = "http://127.0.0.1:9/mcp";
  const gateway = mcpGateway({
    pin: { fake: { url, tools: [{ name: "paid", inputSchema: { type: "object" } }], prices: { paid: 0.5 } } },
    credentials: { fake: { url } },
    work: () => work,
    commit: () => async () => {},
  });
  const call = async () => (await gateway.call("fake", "paid", { query: "q" }, { signal: new AbortController().signal, callId: "c1" })).content?.[0]?.text ?? "";
  const run = await paidRun(t, 0.1, call);
  assertParked(run, 0.1, 0.5, /mcp:fake\/paid, could cost up to \$0\.50/);
});
