// A runner's close in the middle of a turn hands the run back with that turn open: the next claim resumes the same turn,
// and each paid request of the run is billed once. A shutdown's stop holds the claim's journal open until its tool hosts'
// release has run (adapter-loop holdForRelease), so what the turn commits while it unwinds lands too: none of it may end
// the turn, or book a request again on the next claim. The run's ledger then reads as an uninterrupted run's. pi through
// the adapter loop (startRunner over createAdapterLoop), and claude-agent's path (run-adapters' faux harness in its place,
// through an API server and in-process runners, its bash run in a sandbox of the claim's: runner-tool-hand-back's setup).
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";
import { follow, scratch, serve, startInProcessRunner } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { runFolder } = await import("../dist/workspace/paths.js");
const { streamingSandbox } = await import("./fixtures/streaming-sandbox.mjs");
after(closeOpenSessions);

const RUN = "run-1";
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
/** Each model request's price, in dollars. */
const PRICE = 0.25;

/** The run's ledger as its journal reads: each settled step (runner.turn) priced, keyed by its conversation and turn,
 *  and the total. */
async function ledgerOf(store, runId) {
  const row = await store.runs.get(runId);
  const records = await journalRecords(store.journal({ runId, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const settled = records.entries.filter((entry) => entry.kind === "runner.turn").map((entry) => ({ key: `${entry.conversationId}:${entry.data.turn}`, usd: entry.data.usd }));
  const priced = settled.filter((each) => typeof each.usd === "number" && each.usd > 0);
  const total = Math.round(priced.reduce((sum, each) => sum + each.usd, 0) * 1e9) / 1e9;
  const twice = [...new Set(priced.map((each) => each.key))].filter((key) => priced.filter((each) => each.key === key).length > 1);
  return { settled, total, twice, row };
}

/** The tool results the model was sent in `request`, as text. */
const toolResultsOf = (request) => (request?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result")
  .map((block) => (Array.isArray(block.content) ? block.content.map((part) => part.text ?? "").join("\n") : String(block.content ?? "")));

/** A pi run whose one turn calls `wait`, then answers: each request at PRICE. `cut` says where runner-a's close comes:
 *  "tool", while `wait` runs (it holds until its abort); "request", while the turn's second request is open (the model
 *  holds it until its abort); runner-b then claims the run. Undefined: nothing holds, and the run ends on runner-a alone.
 *  The run's end, its ledger, and every request the model was sent. */
async function piRun(t, cut) {
  const opened = await stores({ runners: 2 });
  await queue(opened.server, RUN);
  let started = () => {};
  const running = new Promise((resolve) => (started = resolve));
  const aborted = (signal) => new Promise((_resolve, reject) => {
    const stop = () => reject(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) stop();
    signal?.addEventListener("abort", stop, { once: true });
  });
  const tools = {
    wait: {
      name: "wait", replaySafe: false, ask: false,
      run: async (_args, signal) => {
        if (cut !== "tool") return "waited";
        started();
        return aborted(signal);
      },
    },
  };
  const requests = [];
  let holding = cut === "request";
  const scripted = scriptedOrigin([{ call: "wait" }, { say: "done" }], requests);
  const fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    if (!holding || (body.messages ?? []).every((message) => message.role !== "assistant")) return scripted(url, init);
    requests.push(body);
    started();
    return aborted(init.signal);
  };
  const createLoop = createAdapterLoop(piAdapterSpec({ script: [], tools, hooks: quiet }, { fetch, price: () => PRICE }));
  const start = (name, store) => {
    const runner = startRunner({ store, createLoop, name, ...TIMING });
    t.after(() => runner.close().catch(() => {}));
    return runner;
  };
  const a = start("runner-a", opened.runners[0]);
  if (cut) {
    await running;
    await a.close();
    holding = false;
    start("runner-b", opened.runners[1]);
  }
  await until(async () => {
    const row = await opened.server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(row.state) && row.runner === null;
  }, "the run's end", 60_000);
  return { ...(await ledgerOf(opened.server, RUN)), requests };
}

test("pi: a turn its runner's close cuts while a tool call runs is resumed by the next claim, each request billed once: the ledger reads as an uninterrupted run's", { timeout: 120_000 }, async (t) => {
  const whole = await piRun(t);
  const cut = await piRun(t, "tool");
  const shown = JSON.stringify({ whole: whole.settled, cut: cut.settled });
  assert.equal(whole.row.state, "ended", JSON.stringify(whole.row));
  assert.equal(cut.row.state, "ended", `the resumed turn answered: ${JSON.stringify({ state: cut.row.state, summary: cut.row.summary })}`);
  assert.equal(whole.total, PRICE * 2, `the uninterrupted run: two requests: ${shown}`);
  assert.deepEqual(cut.twice, [], `no step of the cut run was billed twice: ${shown}`);
  assert.equal(cut.total, whole.total, `the cut run's ledger reads as the uninterrupted run's: ${shown}`);
  // The same turn resumed: its second request goes on from the first's call, told it was interrupted; never a new turn.
  assert.equal(cut.requests.length, 2, `two model requests, as uninterrupted: ${cut.requests.length}`);
  assert.deepEqual(cut.requests[1].messages.map((message) => message.role), whole.requests[1].messages.map((message) => message.role), "the resumed request reads as the uninterrupted one's");
  const told = toolResultsOf(cut.requests[1]);
  assert.equal(told.length, 1, JSON.stringify(told));
  assert.match(told[0], /interrupt/i, `the call was interrupted, never run again: ${told[0]}`);
});

test("pi: a turn its runner's close cuts while a model request is open is resumed by the next claim: the open request is booked once, cut, and every other request as an uninterrupted run's", { timeout: 120_000 }, async (t) => {
  const whole = await piRun(t);
  const cut = await piRun(t, "request");
  const shown = JSON.stringify({ whole: whole.settled, cut: cut.settled });
  assert.equal(cut.row.state, "ended", `the resumed turn answered: ${JSON.stringify({ state: cut.row.state, summary: cut.row.summary })}`);
  assert.deepEqual(cut.twice, [], `no step of the cut run was billed twice: ${shown}`);
  assert.equal(cut.settled.filter((each) => each.usd === null).length, 1, `the open request settled once, cut, its cost unknown: ${shown}`);
  assert.equal(cut.total, whole.total, `every answered request billed as the uninterrupted run's: ${shown}`);
  // The same turn resumed: the open request is sent again from where it was, never a new turn.
  assert.equal(cut.requests.length, 3, `the call's request, the open one, and the resumed one: ${cut.requests.length}`);
  assert.deepEqual(cut.requests[2].messages.map((message) => message.role), whole.requests[1].messages.map((message) => message.role), "the resumed request reads as the uninterrupted one's");
});

async function writeMark(dir, name) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, name), "").catch(() => {});
}

/** A claude-agent run (the faux harness's box script: a request calling bash, then one answering, each at $0.001), its
 *  bash run in a sandbox of the claim's over the run's folder. `interrupted`: the command holds until the test lets it
 *  go, and runner-a closes while it runs, runner-b claiming the run; else it ends at once, on runner-a alone. */
async function cliRun(t, interrupted) {
  const marks = await scratch(t);
  const command = interrupted ? `echo ran >> ${marks}/count.txt; touch ${marks}/started; while [ ! -e ${marks}/release ]; do sleep 0.05; done; echo finished` : `echo ran >> ${marks}/count.txt; touch ${marks}/started; echo finished`;
  const harnessTable = fauxTable(FAUX_HARNESS);
  const { api, data, store } = await serve(t, { runner: false, harnessTable });
  const runnerOf = (name) => startInProcessRunner(data, {
    harnessTable,
    runnerTiming: { ...TIMING, name },
    computerForClaim: async (launch) => {
      const folder = runFolder(data, "bash-cli", launch.runId);
      mkdirSync(folder, { recursive: true });
      return streamingSandbox(folder);
    },
  });
  // Saved in the store as the API saves an agent and a run, bash granted on the runner's place (the claim's computer here
  // is the test's sandbox, as a box's would be).
  await store.agents.create({ id: "bash-cli", name: "bash-cli" }, { id: "rev-cli", kind: "agentic", body: { instructions: `Box calls: ${JSON.stringify([{ call: "bash", args: { command } }])}`, tools: ["bash"], harness: "claude-agent" } });
  const runId = "run-cli";
  await store.runs.create({ id: runId, agentId: "bash-cli", revisionId: "rev-cli" }, { body: { input: { content: "Go." }, title: "Go.", place: { mode: "runner" }, harness: "claude-agent", model: { provider: "faux", modelId: "faux-1" } } });
  const a = await runnerOf("runner-a");
  let b;
  t.after(async () => {
    await writeMark(marks, "release");
    await b?.().catch(() => {});
    await a().catch(() => {});
  });
  if (interrupted) {
    await until(() => existsSync(join(marks, "started")), "bash started on runner-a's sandbox", 60_000);
    await a();
    b = await runnerOf("runner-b");
  }
  const { last, rows } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
  await writeMark(marks, "release");
  return { last, rows, ...(await ledgerOf(store, runId)) };
}

test("claude-agent: a turn its runner's close cuts while a tool call runs is resumed by the next claim, each request billed once: the ledger reads as an uninterrupted run's", { timeout: 180_000 }, async (t) => {
  const whole = await cliRun(t, false);
  const cut = await cliRun(t, true);
  const shown = JSON.stringify({ whole: whole.settled, cut: cut.settled, rows: cut.rows.map((r) => [r.kind, r.summary, r.tool_status]) });
  assert.equal(whole.last.status, "completed", shown);
  assert.equal(cut.last.status, "completed", `the resumed turn answered: ${shown}`);
  assert.deepEqual(cut.rows.filter((r) => r.kind === "final_answer").map((r) => r.summary), ["Done in the box."], `one answer, the resumed turn's: ${shown}`);
  const results = cut.rows.filter((r) => r.kind === "tool_result");
  assert.deepEqual(results.map((r) => [r.tool_status, /^interrupted: /.test(r.tool_result_preview ?? "")]), [["failed", true]], `the call's one result: interrupted, never run again: ${shown}`);
  assert.equal(whole.total, 0.002, `the uninterrupted run: the call's request and the answer's: ${shown}`);
  assert.deepEqual(cut.twice, [], `no step of the cut run was billed twice: ${shown}`);
  assert.equal(cut.total, whole.total, `the cut run's ledger reads as the uninterrupted run's: ${shown}`);
});
