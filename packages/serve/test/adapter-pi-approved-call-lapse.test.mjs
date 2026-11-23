// An approved call and a lost claim, on pi through the adapter loop. The contract (tool-gate.ts, answerApproval): allow
// runs the call once; a read the runner lost mid-call may run again on its next claim; a call with a side effect never
// does. Each case: the person allows a call set to ask, and while it runs, the runner's renews fail and its claim runs
// out at its deadline (not-renewed, on the clock the test moves, so no stall of a loaded machine decides it). The run is
// claimed again at the next epoch. A call with a side effect (replay never) ran once, and the next claim answers it
// interrupted, to the model too; a read (replay safe) runs again, by design. Either way the lapse is recorded: run_attempts
// cuts the lost claim's attempt lease_lapse, and the claim that took over says that was its cause.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { fakeClock, observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { callsOf, journalRecords } = await import("../dist/runner/journal-reader.js");

// A lease no stall of a loaded machine runs out: the claim is lost only where the case loses it, at the deadline on the
// runner's clock the case moves. The renew tick is short; only the lease is long.
const TIMING = { ...STEADY_LEASE, renewEveryMs: 100, pollMs: 20, commandPollMs: 20 };
const WAIT_MS = 15_000;
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** A tool set to ask whose approved call runs until `letGo()` or its signal ends it: `tool.ran` counts its runs. */
function heldTool(name, replaySafe) {
  let letGo = () => {};
  const gate = new Promise((resolve) => (letGo = resolve));
  const tool = {
    name,
    replaySafe,
    ask: true,
    ran: 0,
    run: async (_args, signal) => {
      tool.ran += 1;
      await Promise.race([gate, new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
      return `${name} done`;
    },
  };
  return { tool, letGo: () => letGo() };
}

/** The text of each tool result the model was handed in `body` (an Anthropic Messages request). */
const toolResultsIn = (body) =>
  (body?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === "tool_result")
    .map((part) => (typeof part.content === "string" ? part.content : (part.content ?? []).map((each) => each.text ?? "").join("")));

/** run-1 calls `tool` (set to ask), parks, is allowed; the call runs, and while it runs the runner's claim runs out
 *  unrenewed. The run is claimed again (the store's clock past the lost claim's until) and ends. Returns what the case
 *  checks: the tool's runs, the run's attempts, its calls as its journal keeps them, the lost epoch, and the model's
 *  requests. */
async function lapsedWhileItRuns(t, held) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const record = recorder();
  const clock = fakeClock();
  const events = [];
  const requests = [];
  const script = [{ call: held.tool.name }, { say: "done" }];
  const spec = piAdapterSpec({ script, tools: { [held.tool.name]: held.tool }, hooks: quiet }, { requests });
  const createLoop = createAdapterLoop(spec, { restartLimit: MAX_RESTARTS });
  // The runner's store, recording (observed: its renews refused while the case says so), with its run_attempts' word for
  // a lapse (runner.ts loseClaim), as the server's runner has it.
  const store = { ...observed(opened.runners[0], record), runAttempts: opened.runners[0].runAttempts };
  const runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING, clock, onEvent: (event) => events.push(event) });
  t.after(async () => {
    held.letGo();
    await runner.close();
  });
  const settled = (state) => until(async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === state && row.runner === null && row;
  }, `the run ${state} and released`, WAIT_MS);
  const read = async () => {
    const row = await opened.server.runs.get("run-1");
    return journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  };

  await settled("parked");
  const [ask] = (await read()).entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
  assert.equal(ask?.tool, held.tool.name, "the call waits for its person");
  assert.equal(held.tool.ran, 0, "nothing ran while it waits");
  await sendCommand(opened.server, "run-1", { kind: "approve", body: { approval: ask.callId } });
  await until(() => held.tool.ran === 1, "the approved call runs", WAIT_MS);
  const lost = events.filter((event) => event.type === "claimed").at(-1).claim.epoch;
  const answered = (await read()).entries.filter((entry) => entry.kind === "agentrun.answer").map((entry) => entry.data);
  assert.deepEqual(answered.map((answer) => [answer.callId, answer.decision]), [[ask.callId, "allow"]], "the person's allow is on the record before the call's end is");

  // Every renew fails from here (the store busy), and the runner's deadline passes: its claim is lost while the call runs,
  // its end not yet recorded.
  record.blockRenew.add("runner-a");
  clock.advance(TIMING.leaseMs);
  await until(() => events.find((event) => event.type === "claim-lost" && event.epoch === lost), "the runner loses its claim at its deadline", WAIT_MS);
  const loss = events.find((event) => event.type === "claim-lost" && event.epoch === lost);
  assert.equal(loss.why, "not-renewed", "lost unrenewed, at its deadline");
  await until(async () => (await opened.server.runAttempts.forRun("run-1")).find((attempt) => attempt.epoch === lost && attempt.cut === "lease_lapse"), "the lost claim's attempt is cut lease_lapse", WAIT_MS);

  // The first run of the call may go on (a lost claim's in-flight work is not recalled): let it end now, its end refused
  // by the fence. Renews work again, and the store's clock passes the lost claim's until: the run is claimed again.
  held.letGo();
  record.blockRenew.delete("runner-a");
  opened.clock.skewMs = TIMING.leaseMs * 2;
  await settled("ended");
  const attempts = await opened.server.runAttempts.forRun("run-1");
  const records = await read();
  return { ask, lost, attempts, calls: callsOf(records), answers: records.entries.filter((entry) => entry.kind === "agentrun.answer").map((entry) => entry.data), requests, events };
}

/** The lapse on the record: the lost claim's attempt cut lease_lapse, and the claim that took over (from running, the
 *  same turn, one attempt more) names it as its cause. */
function lapseRecorded({ attempts, lost }) {
  const shown = JSON.stringify(attempts);
  const cut = attempts.find((attempt) => attempt.epoch === lost);
  assert.equal(cut?.cut, "lease_lapse", `the lost claim's attempt is cut lease_lapse: ${shown}`);
  const next = attempts.find((attempt) => attempt.epoch === lost + 1);
  assert.ok(next, `the run was claimed again at the next epoch: ${shown}`);
  assert.deepEqual([next.from, next.cause, next.turn, next.attempt], ["running", "lease_lapse", cut.turn, cut.attempt + 1], `the next claim took the lost one's turn over, its cause the lapse: ${shown}`);
}

test("an approved call with a side effect, its claim lost while it runs: it ran once, never again on the next claim, which answers it interrupted, to the model too", { timeout: 60_000 }, async (t) => {
  const held = heldTool("send", false);
  const w = await lapsedWhileItRuns(t, held);
  assert.equal(held.tool.ran, 1, "the allowed call with a side effect ran once across the lost claim and the next");
  lapseRecorded(w);
  assert.deepEqual(w.calls.filter((call) => call.tool === "send").map((call) => [call.callId, call.status]), [[w.ask.callId, "interrupted"]], "the next claim ended the call interrupted, unrun");
  assert.deepEqual(w.answers.map((answer) => [answer.callId, answer.decision]), [[w.ask.callId, "allow"]], "the person was asked once and answered once: the next claim never asked again");
  const told = toolResultsIn(w.requests.at(-1));
  assert.ok(told.length === 1 && /interrupted/.test(told[0]), `the model was told the call was interrupted: ${JSON.stringify(told)}`);
});

test("an approved read, its claim lost while it runs: it runs again on the next claim (a read is safe to repeat), and the lapse is recorded", { timeout: 60_000 }, async (t) => {
  const held = heldTool("lookup", true);
  const w = await lapsedWhileItRuns(t, held);
  // On purpose: an approved read stays at least once. A read the runner lost mid-call runs again on its next claim.
  assert.equal(held.tool.ran, 2, "the allowed read ran on the lost claim and again on the next");
  lapseRecorded(w);
  assert.deepEqual(w.calls.filter((call) => call.tool === "lookup").map((call) => [call.callId, call.status]), [[w.ask.callId, "done"]], "the call ended done, once, on the record");
  assert.deepEqual(w.answers.map((answer) => [answer.callId, answer.decision]), [[w.ask.callId, "allow"]], "the person was asked once and answered once: the rerun is not asked again");
  const told = toolResultsIn(w.requests.at(-1));
  assert.deepEqual(told, ["lookup done"], "the model read the read's result");
});
