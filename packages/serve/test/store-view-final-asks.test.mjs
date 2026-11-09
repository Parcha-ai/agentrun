// The store's readers of a run's approvals on a FINAL run: a call it asked about that has no answer in its journal (the
// shape a stopped end leaves when its journal would not take the withdrawal, written on the run's row alone) reads
// withdrawn wherever it is read: the timeline's approval row (the view's and the served one), nothing pending, and the
// run's moment (what an answer is checked against: no approval waiting, a repeat allow refused in main's words). A LIVE
// parked run's unanswered call still reads waiting, and a call the stop's end withdrew reads as it did. A stop's
// withdrawal over an allow it overrode (its `superseded`) is the call's answer, not the allow before it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { momentOverStore, timelineOverStore, viewOverStore } = await import("../dist/store-view.js");
const { servedTimelineRows } = await import("../dist/run-timeline-served.js");
const { answersOf, withApprovalRows } = await import("../dist/run-view.js");
const { approve } = await import("../dist/runs-over-store.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const DEPS = { origin: "", serverSecrets: () => [] };
const SERVED = { serverSecrets: () => [], keyEnv: () => ({}) };
const END = "agentrun.end";
after(closeOpenSessions);

/** `store` with each journal commit that carries the run's end refused while `refusing()` says so. */
function refusingEnds(store, refusing) {
  const journalOf = (journal) =>
    new Proxy(journal, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "commit") return typeof value === "function" ? value.bind(target) : value;
        return async (...args) => {
          if (refusing() && JSON.stringify(args[0] ?? null)?.includes(`"${END}"`)) throw new Error("the journal refused the end (a test's refusal)");
          return value.apply(target, args);
        };
      },
    });
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "journal") return (...args) => journalOf(value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** One pi run whose model calls `add`, which its gate asks about, parked on that call; its runner's end commits refused
 *  while `refusing()` says so. */
async function parkedRun(t, refusing = () => false) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const tools = { add: { name: "add", replaySafe: false, ask: true, run: async () => "5" } };
  const script = [{ call: "add", args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, []) });
  const gate = Object.assign(() => "ask", { askedAs: (tool) => tool });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await base(claim, run)), gate }));
  const runner = startRunner({ store: refusingEnds(opened.runners[0], refusing), createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(async () => (await opened.server.runs.get("run-1")).state === "parked", "the run parked on the call", 30_000);
  return opened.server;
}

/** Every reader of the run's one approval: the view's pending, its approval row in the view's timeline and the served
 *  one, and the run's moment (the approval it waits on, the answer it holds for the call). */
async function readers(server) {
  const view = await viewOverStore(server, "run-1", DEPS);
  const approvalRow = (rows) => rows.find((row) => row.kind === "tool_approval_requested")?.summary ?? "";
  const moment = await momentOverStore(server, "run-1");
  return {
    status: view.status,
    pending: view.pending?.kind ?? null,
    row: approvalRow(await timelineOverStore(server, "run-1", DEPS)),
    served: approvalRow(await servedTimelineRows(SERVED, server, "run-1", {})),
    waiting: moment.waitingApprovalId ?? null,
    moment,
  };
}

const stoppedRowOnly = (server) =>
  until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "stopped" && row;
  }, "the run ended stopped", 30_000);

test("a final run whose asked call has no answer in its journal reads it withdrawn everywhere: no reader says waiting", { timeout: 60_000 }, async (t) => {
  // Its end refused by the journal: the runner ends it stopped on its row alone, the ask left with no answer.
  let refusing = false;
  const server = await parkedRun(t, () => refusing);
  refusing = true;
  await server.command("run-1", { kind: "stop" });
  await stoppedRowOnly(server);
  const seen = await readers(server);
  assert.equal(seen.status, "cancelled");
  assert.equal(seen.pending, null, "nothing pending");
  assert.match(seen.row, /^Withdrawn when the run was stopped: add /, "the view's approval row");
  assert.match(seen.served, /^Withdrawn when the run was stopped: add /, "the served timeline's approval row");
  assert.equal(seen.waiting, null, "the run's moment names no approval waiting");
  const [callId] = seen.moment.approvalIds ?? [];
  // A repeat allow is refused in main's words (runs.ts approve: "The tool call <id> was already withdrawn when its run
  // was stopped.").
  await assert.rejects(approve(server, seen.moment, callId, "allow"), { message: `The tool call ${callId} was already withdrawn when its run was stopped.` });
});

test("a live parked run's unanswered call still reads waiting", { timeout: 60_000 }, async (t) => {
  const server = await parkedRun(t);
  const seen = await readers(server);
  assert.equal(seen.pending, "approval");
  assert.match(seen.row, /^Waiting for your approval: add /);
  assert.match(seen.served, /^Waiting for your approval: add /);
  assert.notEqual(seen.waiting, null);
});

test("a call the stop's end withdrew reads as it did", { timeout: 60_000 }, async (t) => {
  const server = await parkedRun(t);
  await server.command("run-1", { kind: "stop" });
  await stoppedRowOnly(server);
  const seen = await readers(server);
  assert.equal(seen.pending, null);
  assert.match(seen.row, /^Withdrawn when the run was stopped: add /);
  assert.match(seen.served, /^Withdrawn when the run was stopped: add /);
  assert.equal(seen.waiting, null);
});

test("a stop's withdrawal over an allow it overrode is the call's answer, keeping the allow it superseded", () => {
  const ask = { kind: "agentrun.ask", data: { callId: "c1", tool: "add", args: { a: 2, b: 3 }, requestedAt: "2026-11-09T00:00:00.000Z" } };
  const allow = { kind: "agentrun.answer", data: { callId: "c1", approved: true, decision: "allow", answeredAt: "2026-11-09T00:00:01.000Z" } };
  const withdrawn = { kind: "agentrun.answer", data: { callId: "c1", approved: false, decision: "withdrawn", answeredAt: "2026-11-09T00:00:02.000Z", superseded: { decision: "allow", answeredAt: "2026-11-09T00:00:01.000Z" } } };
  const answers = answersOf([ask, allow, withdrawn]);
  assert.equal(answers.c1.decision, "withdrawn");
  assert.deepEqual(answers.c1.superseded, { decision: "allow", answered_at: "2026-11-09T00:00:01.000Z" });
  // Without a superseding withdrawal, the first answer stands, as before.
  assert.equal(answersOf([ask, allow, { kind: "agentrun.answer", data: { callId: "c1", approved: false, decision: "deny" } }]).c1.decision, "allow");
  const row = { id: "r1", seq: 1, kind: "tool_use", tool_use_id: "c1", tool_name: "add", summary: "add", text: "" };
  const asks = new Map([["c1", { id: "c1", tool: "add", call_id: "c1", args_json: "{\"a\":2,\"b\":3}", requested_at: "2026-11-09T00:00:00.000Z" }]]);
  const rows = withApprovalRows([row], asks, answers, (text) => text);
  assert.match(rows.find((one) => one.kind === "tool_approval_requested").summary, /^Withdrawn when the run was stopped: add /);
});
