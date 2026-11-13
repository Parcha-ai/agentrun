// The cap's wrap-up (tool-budget.ts wrappingUp): once a capped run's spend plus what its requests still out hold reaches
// WRAP_UP_SHARE of its cap, the run's tool gate refuses every call the model makes, in one fixed text, in every
// conversation of the run (a delegate's spawn of a child conversation, as a `subagent` spawn, included). Children in
// flight are not cut: their own next calls are refused and they answer, and the parent's final answer still lands under
// the cap. The figure is read from the run's booking records, so a claim moved to another runner holds the same line. A
// run with no cap is unchanged.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { closeOpenSessions, hostTools, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { sleep, STEADY_LEASE, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { suiteTools, MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { TOOL_BUDGET_TEXT, WRAP_UP_SHARE, WRAP_UP_TEXT, wrappingUp } = await import("../dist/tool-budget.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

// The model as the cap prices it: output only, so a request's hold is its output limit at that price and its bound is 0.
// Each request asks for OUTPUT tokens and is held at HOLD; the provider bills each answer at BILLED (the adapter's price).
const OUTPUT = 4_096;
const priced = (holdUsd) => Object.freeze({ id: MODEL, api: "anthropic-messages", price: { input: 0, output: (holdUsd / OUTPUT) * 1e6 }, outputCeiling: OUTPUT });

/** Every tool result the provider got, in order, by the request that first carried it: its text and whether it is an error. */
function resultsIn(requests) {
  const seen = new Map();
  for (const body of requests) {
    for (const part of (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))) {
      if (part.type !== "tool_result" || seen.has(part.tool_use_id)) continue;
      const blocks = typeof part.content === "string" ? [{ type: "text", text: part.content }] : part.content ?? [];
      seen.set(part.tool_use_id, { text: blocks.filter((block) => block.type === "text").map((block) => block.text).join(""), isError: part.is_error === true });
    }
  }
  return [...seen.values()];
}
const texts = (requests) => resultsIn(requests).map((result) => result.text);

// A native tool that opens a conversation of its own, as a `subagent` does (owned by its call's task, on the session's
// model, with the session's read tool), sends it "child task <n>" and answers with its last words. Its calls run at once.
const CHILD = "child task";
const delegate = defineExtension({
  name: "test-delegate",
  tools: [
    defineTool({
      name: "delegate",
      description: "Hands a task to a conversation of its own.",
      parameters: { type: "object", properties: { n: { type: "number" } } },
      replay: "safe",
      executionMode: "parallel",
      execute: async (args, api, context) => {
        const parent = await api.agent(context);
        const child = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, created.id, { model: parent.model, tools: parent.tools.filter((tool) => tool.name === "read"), modelTools: null, instructions: "Follow the script." });
          return created.id;
        }, context);
        const handle = await api.conversation(child, context);
        const settled = await (await handle.submit({ type: "input", content: `${CHILD} ${args.n}`, requestId: `delegate:${String(api.taskId)}` }, context)).wait(context);
        const answer = settled.answer === undefined ? undefined : await api.commit((tx) => tx.entry(settled.answer), context);
        const said = answer?.model?.findLast((message) => message.role === "assistant")?.content?.map((part) => part.text ?? "").join("") ?? "";
        return { output: [{ type: "text", text: said }] };
      },
    }),
  ],
});
/** Which child a request is (its first message names it), or 0 for the root's. */
const childOf = (body) => Number(/child task (\d+)/.exec(JSON.stringify(body.messages?.[0] ?? {}))?.[1] ?? 0);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

/** A store with run-1 queued, a runner on the adapter loop under `capUsd` (undefined: no cap), the model held at `hold`
 *  and billed at `billed` a request, its root and children answered by `fetch`. `judged`: each request the cap judged. */
async function wrapRun(t, { capUsd, hold, billed, fetch, tools, onLedger }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-cap-wrap-up-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Wrap" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const judged = [];
  const loop = createAdapterLoop((_claim, run) => (onLedger?.(run.ledger), {
    adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" }, fetch, price: () => billed, extensions: [delegate] }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
    input: "Follow the script.",
    runCap: { capUsd: () => capUsd, modelOf: () => priced(hold), judged: (request, answer) => void judged.push(answer) },
    hooks: quiet,
    gate: () => "allow",
  }), { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state !== "running" && now.state !== "queued" && now.runner === null && now;
  }, "the run settled", 30_000);
  return { row, judged };
}

// The root hands three children their tasks at once, then would hand a fourth, then answers. Child 1 would read six
// times; children 2 and 3 answer at once, but their first requests stay out (held) until child 1's first call is
// answered, so child 1 works while their reservations sit on the cap: what a parent's fan-out does to a small cap.
const ROOT = [{ calls: [{ call: "delegate", args: { n: 1 } }, { call: "delegate", args: { n: 2 } }, { call: "delegate", args: { n: 3 } }] }, { call: "delegate", args: { n: 4 } }, { say: "root answer from what the children found" }];
const CHILD_1 = [...Array.from({ length: 6 }, () => ({ call: "read" })), { say: "child 1 done" }];
const CHILD_N = (n) => [{ say: `child ${n} done` }];

/** Whether a request's newest tool result is the wrap-up's refusal: a model that reads it answers. */
const toldToWrapUp = (body) => resultsIn([body]).at(-1)?.text === WRAP_UP_TEXT;

/** The fan-out's origin: the root's and each child's scripts, children 2 and 3 held out until child 1's first call is
 *  answered. Child 1 answers as soon as it reads the wrap-up's refusal, as a model told to does. */
function fanOut() {
  const requests = { 0: [], 1: [], 2: [], 3: [], 4: [] };
  const origins = { 0: scriptedOrigin(ROOT, requests[0]), 1: scriptedOrigin(CHILD_1, requests[1]), 2: scriptedOrigin(CHILD_N(2), requests[2]), 3: scriptedOrigin(CHILD_N(3), requests[3]), 4: scriptedOrigin(CHILD_N(4), requests[4]) };
  const child1Wraps = scriptedOrigin(Array.from({ length: CHILD_1.length }, () => ({ say: "child 1 done" })), requests[1]);
  const out = { 2: deferred(), 3: deferred() };
  const release = deferred();
  const fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    const which = childOf(body);
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    if ((which === 2 || which === 3) && step === 0) {
      out[which].resolve();
      await release.promise;
    }
    // Child 1 starts once both reservations are out, and lets them go once it answers (its first request with no tool call).
    if (which === 1 && step === 0) await Promise.all([out[2].promise, out[3].promise]);
    if (which !== 1) return origins[which](url, init);
    // Child 1's next request, once its first call has been answered or refused: the reservations go.
    if (step > 0) release.resolve();
    return (toldToWrapUp(body) ? child1Wraps : origins[1])(url, init);
  };
  return { requests, fetch };
}

test("the rule: a capped run wraps up once its spend and holds reach the share of its cap; no cap, or a figure unknown, never", () => {
  assert.equal(WRAP_UP_SHARE, 0.75);
  assert.equal(wrappingUp(1, 0.74), false);
  assert.equal(wrappingUp(1, 0.75), true);
  assert.equal(wrappingUp(0.3, 0.3), true, "a run at its cap");
  assert.equal(wrappingUp(undefined, 1e6), false, "no cap");
  assert.equal(wrappingUp(1, null), false, "a spend no one knows: the cap refuses the next request for that");
  assert.notEqual(WRAP_UP_TEXT, TOOL_BUDGET_TEXT);
});

test("children whose reservations push the run near its cap wrap up: in-flight children answer, no new child spawns, and the parent's answer lands under the cap", async (t) => {
  // Cap $1, each request held at $0.30 and billed at $0.13. When child 1 first calls, the run has spent $0.26 (the root's
  // first request and its own) and children 2 and 3 hold $0.57-0.60: the line ($0.75) is crossed by reservations, not
  // spend.
  const CAP = 1;
  const BILLED = 0.13;
  const { requests, fetch } = fanOut();
  const { tools, ran } = suiteTools();
  const { row, judged } = await wrapRun(t, { capUsd: CAP, hold: 0.3, billed: BILLED, fetch, tools });
  assert.deepEqual([row.state, row.summary], ["ended", null], `the run ended answered, never spend_cap_reached: ${JSON.stringify(row)}`);
  assert.equal(judged.filter((answer) => answer && "refuse" in answer).length, 0, "the cap refused no request");
  // Child 1: its first read refused in the wrap-up's words, and it answered at once.
  assert.equal(ran.read, 0, "no read ran");
  assert.deepEqual(resultsIn(requests[1]), [{ text: WRAP_UP_TEXT, isError: true }]);
  assert.equal(requests[1].length, 2, "child 1 answered on its next request");
  // Children 2 and 3, in flight all along, answered; the fourth child was never spawned.
  assert.equal(requests[2].length, 1);
  assert.equal(requests[3].length, 1);
  assert.equal(requests[4].length, 0, "the fourth child was never spawned");
  assert.deepEqual(texts(requests[0]), ["child 1 done", "child 2 done", "child 3 done", WRAP_UP_TEXT], "the root's spawn after the fan-out was refused in the same words");
  assert.equal(requests[0].length, ROOT.length, "the root answered last");
  // Nothing billed past the cap: every request that reached the provider is billed once.
  const sent = Object.values(requests).reduce((sum, list) => sum + list.length, 0);
  assert.ok(sent * BILLED <= CAP, `billed $${(sent * BILLED).toFixed(2)} of a $${CAP} cap`);
});

test("a hold-only reservation still open (a browser session's reserve) counts toward the line, as the cap holds it", async (t) => {
  // Cap $1, each request held and billed at $0.01. The first call reserves $0.80 of the cap as a hold-only paid step (what
  // a browser session's reserve is), left open; the next call is refused though the run has spent $0.02.
  let ledger;
  const ran = { read: 0 };
  const tools = {
    reserve: { name: "reserve", replaySafe: false, run: async () => (await ledger.paid.admit({ id: "reserve-1", name: "a browser session", holdUsd: 0.8, basis: "its reserve", hold: true }), "reserved") },
    read: { name: "read", replaySafe: true, run: async () => (ran.read++, "read") },
  };
  const requests = [];
  const fetch = scriptedOrigin([{ call: "reserve" }, { call: "read" }, { say: "answered with the reserve still open" }], requests);
  const { row, judged } = await wrapRun(t, { capUsd: 1, hold: 0.01, billed: 0.01, fetch, tools, onLedger: (given) => void (ledger = given) });
  assert.deepEqual([row.state, row.summary], ["ended", null], JSON.stringify(row));
  assert.deepEqual(texts(requests), ["reserved", WRAP_UP_TEXT]);
  assert.equal(ran.read, 0);
  assert.equal(judged.filter((answer) => answer && "refuse" in answer).length, 0, "the cap refused no request");
});

test("a run with no cap is unchanged: every child runs its whole script and every spawn is made", async (t) => {
  const { requests, fetch } = fanOut();
  const { tools, ran } = suiteTools();
  const { row } = await wrapRun(t, { capUsd: undefined, hold: 0.3, billed: 0.13, fetch, tools });
  assert.deepEqual([row.state, row.summary], ["ended", null], JSON.stringify(row));
  assert.equal(ran.read, 6, "child 1 read six times");
  assert.equal(resultsIn(Object.values(requests).flat()).filter((result) => result.text === WRAP_UP_TEXT).length, 0);
  assert.equal(requests[4].length, 1, "the fourth child was spawned");
  assert.deepEqual(texts(requests[0]), ["child 1 done", "child 2 done", "child 3 done", "child 4 done"]);
});

test("the wrap-up holds across a claim moved to another runner: it is read from the run's records, never kept in memory", async (t) => {
  // Cap $1, each request held and billed at $0.25: read and slow run ($0.25, $0.50 taken), the claim is lost while slow is
  // out, and on the next claim the third request's read is refused ($0.75 taken), and the answer is the fourth.
  const CAP = 1;
  const USD = 0.25;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-cap-wrap-up-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const runnerStores = [await openSqliteStore({ dataDir: dir, role: "runner" }), await openSqliteStore({ dataDir: dir, role: "runner" })];
  const runners = [];
  const { tools, ran, letSlowGo, slowStarted } = suiteTools();
  t.after(async () => {
    letSlowGo();
    for (const runner of runners) await runner.close().catch(() => {});
    for (const each of runnerStores) await each.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Wrap" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const requests = [];
  const script = [{ call: "read" }, { call: "slow" }, { call: "read" }, { say: "answered under the cap" }];
  const judged = [];
  const loop = createAdapterLoop((_claim, run) => ({
    adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests), price: () => USD }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
    input: "Follow the script.",
    runCap: { capUsd: () => CAP, modelOf: () => priced(USD), judged: (_request, answer) => void judged.push(answer) },
    hooks: quiet,
    gate: () => "allow",
  }), { restartLimit: MAX_RESTARTS });
  // The first runner on a short lease, lost while slow is out; the second takes the run once it lapses.
  runners.push(startRunner({ store: runnerStores[0], createLoop: loop, name: "runner-a", leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 }));
  await slowStarted;
  runners[0].kill();
  runners.push(startRunner({ store: runnerStores[1], createLoop: loop, name: "runner-b", ...TIMING }));
  await until(async () => (await server.runs.get("run-1")).runner === "runner-b", "the second runner took the run", 10_000);
  letSlowGo();
  let row;
  for (const deadline = Date.now() + 30_000; ; await sleep(20)) {
    row = await server.runs.get("run-1");
    if (row.state !== "running" && row.state !== "queued" && row.runner === null) break;
    assert.ok(Date.now() < deadline, `the run settled: ${JSON.stringify(row)}`);
  }
  assert.deepEqual([row.state, row.summary], ["ended", null], `the run ended answered: ${JSON.stringify(row)}`);
  assert.equal(ran.read, 1, "the read on the new claim was refused");
  assert.deepEqual(resultsIn(requests).at(-1), { text: WRAP_UP_TEXT, isError: true });
  assert.equal(judged.filter((answer) => answer && "refuse" in answer).length, 0, "the cap refused no request");
  assert.ok(requests.length * USD <= CAP, `billed $${requests.length * USD} of a $${CAP} cap`);
});
