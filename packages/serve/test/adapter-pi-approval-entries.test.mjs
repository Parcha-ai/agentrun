// pi through the adapter loop: the journal's ask and answer entries carry what main's approval card shows (tool-gate.ts
// ApprovalRequest, written as the "requested" approval entry, and its "resolved" entry), so a store-backed run view
// renders the card and its answered state from them alone.
// - agentrun.ask: the call's input as the gate saw it (args, null when none), when it was asked (requestedAt, ISO, from
//   the loop's clock) and what it costs (price, the spec's approval price, null when the call has none). A call asked
//   again on a resume keeps its first request: the same card for the same call.
// - agentrun.answer: allow, deny or withdrawn (decision), when (answeredAt, ISO, from the loop's clock), and a deny's
//   note. A stop while the call waits withdraws it, in the stop's end commit.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { suiteTools, MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const TIMING = { leaseMs: 30_000, renewEveryMs: 150, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

const ASKED_AT = Date.parse("2026-11-08T12:00:00.000Z");
const ANSWERED_AT = Date.parse("2026-11-08T12:05:30.250Z");
const ARGS = { to: "ops@example.com", subject: "weekly totals" };

/** A run whose first step calls the asked tool with ARGS, parked on it; the loop's clock is the test's (`clock.at`), and
 *  the asked tool's approval price is `price`. `noResume`: the loop of any claim after the park cannot start (its start
 *  throws, as a harness that can't open), so the runner itself ends the run on a stop (resumeFailed). */
async function parkedRun(t, { price, noResume = false } = {}) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const { tools, ran } = suiteTools();
  const script = [{ call: "asked", args: ARGS }, { say: "done" }];
  const spec = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script) });
  const clock = { at: ASKED_AT };
  const loop = createAdapterLoop(async (claim, run) => ({
    ...(await spec(claim, run)),
    ...(price !== undefined ? { approvalPrice: (call) => (call.tool === "asked" ? price : undefined) } : {}),
  }), { restartLimit: MAX_RESTARTS, now: () => clock.at });
  const createLoop = noResume
    ? (deps) => {
        const inner = loop(deps);
        return { ...inner, start: (claim) => (claim.from === "parked" ? Promise.reject(new Error("the run's harness could not open")) : inner.start(claim)) };
      }
    : loop;
  const runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING, now: () => clock.at });
  t.after(() => runner.close());
  const settled = (state) => until(async () => {
    const row = await opened.server.runs.get("run-1");
    return row.state === state && row.runner === null && row;
  }, `the run ${state} and released`, 15_000);
  await settled("parked");
  const read = async () => {
    const row = await opened.server.runs.get("run-1");
    return (await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
  };
  const asks = async () => (await read()).filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
  const answers = async () => (await read()).filter((entry) => entry.kind === "agentrun.answer").map((entry) => entry.data);
  return { opened, ran, clock, settled, asks, answers };
}

test("an asked call's ask carries its args, when it was asked and its price, kept on a re-ask; its approve is an allow, answered then", async (t) => {
  const w = await parkedRun(t, { price: 0.25 });
  const [ask] = await w.asks();
  assert.deepEqual(ask, { callId: ask.callId, tool: "asked", args: ARGS, requestedAt: "2026-11-08T12:00:00.000Z", price: 0.25 }, "main's card: the call's input, its request time, its price");
  // A steer wakes the run with no answer: the call is asked again, the same request.
  w.clock.at = ASKED_AT + 60_000;
  await sendCommand(w.opened.server, "run-1", { kind: "steer", body: { text: "any news?" } });
  await until(async () => (await w.asks()).length === 2, "the call asked again on the resume", 15_000);
  await w.settled("parked");
  assert.deepEqual(await w.asks(), [ask, ask], "asked again, the same request: its args, its first request time, its price");
  w.clock.at = ANSWERED_AT;
  await sendCommand(w.opened.server, "run-1", { kind: "approve", body: { approval: ask.callId } });
  await w.settled("ended");
  assert.equal(w.ran.asked, 1, "approved, it ran once");
  assert.deepEqual(await w.answers(), [{ callId: ask.callId, approved: true, decision: "allow", answeredAt: "2026-11-08T12:05:30.250Z" }]);
});

test("a deny's answer is a deny with its note, answered then; a call with no approval price is asked at null", async (t) => {
  const w = await parkedRun(t);
  const [ask] = await w.asks();
  assert.equal(ask.price, null, "no approval price: null, as main's card has none");
  w.clock.at = ANSWERED_AT;
  await sendCommand(w.opened.server, "run-1", { kind: "deny", body: { approval: ask.callId, note: "not on a Friday" } });
  await w.settled("ended");
  assert.equal(w.ran.asked, 0, "denied, it never ran");
  assert.deepEqual(await w.answers(), [{ callId: ask.callId, approved: false, decision: "deny", answeredAt: "2026-11-08T12:05:30.250Z", note: "not on a Friday" }]);
});

test("a stop while the call waits withdraws it: a withdrawn answer in the stop's end commit, answered then", async (t) => {
  const w = await parkedRun(t, { price: 0.25 });
  const [ask] = await w.asks();
  w.clock.at = ANSWERED_AT;
  const stop = await sendCommand(w.opened.server, "run-1", { kind: "stop", body: {} });
  const row = await w.settled("stopped");
  assert.equal(w.ran.asked, 0, "withdrawn, it never ran");
  assert.deepEqual(await w.answers(), [{ callId: ask.callId, approved: false, decision: "withdrawn", answeredAt: "2026-11-08T12:05:30.250Z" }]);
  assert.ok((await w.opened.server.commands("run-1", stop.id - 1)).find((command) => command.id === stop.id).takenAt !== null, "the stop row is taken");
  assert.match(row.summary ?? "", /stopped/);
});

test("a stop of a parked run whose loop cannot start: the runner's own stopped end withdraws the waiting call, in that end's commit, answered then", async (t) => {
  const w = await parkedRun(t, { noResume: true });
  const [ask] = await w.asks();
  w.clock.at = ANSWERED_AT;
  const stop = await sendCommand(w.opened.server, "run-1", { kind: "stop", body: {} });
  const row = await w.settled("stopped");
  assert.equal(w.ran.asked, 0, "withdrawn, it never ran");
  assert.deepEqual(await w.answers(), [{ callId: ask.callId, approved: false, decision: "withdrawn", answeredAt: "2026-11-08T12:05:30.250Z" }], "the card reads answered, never waiting for good");
  assert.ok((await w.opened.server.commands("run-1", stop.id - 1)).find((command) => command.id === stop.id).takenAt !== null, "the stop row is taken");
  assert.match(row.summary ?? "", /stopped/);
});
