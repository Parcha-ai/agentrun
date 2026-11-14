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
async function parkedRun(t, { price, noResume = false, setting } = {}) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const { tools, ran } = suiteTools();
  const script = [{ call: "asked", args: ARGS }, { say: "done" }];
  const spec = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script) });
  const clock = { at: ASKED_AT };
  const loop = createAdapterLoop(async (claim, run) => ({
    ...(await spec(claim, run)),
    // Its price as a catalog tool's card reads it (the spec's catalog seam, AdapterRunSpec.mcp priceOf).
    ...(price !== undefined ? { mcp: { tools: [], catalogOf: () => undefined, priceOf: (name) => (name === "asked" ? price : undefined), fresh: async () => {}, release: () => {} } } : {}),
    // The tool's setting as `setting.now` reads it at each call (the server's gate): "ask", then perhaps "allow".
    ...(setting ? { gate: async () => setting.now } : {}),
  }), { restartLimit: MAX_RESTARTS, now: () => clock.at });
  const createLoop = noResume
    ? (deps) => {
        const inner = loop(deps);
        return { ...inner, start: (claim) => (claim.from === "parked" ? Promise.reject(new Error("the run's harness could not open")) : inner.start(claim)) };
      }
    : loop;
  // The runner, closed at the case's end; a case may close it and start another (`restart`) on the same loop.
  let runner = startRunner({ store: opened.runners[0], createLoop, name: "runner-a", ...TIMING, now: () => clock.at });
  t.after(() => runner.close());
  const closeRunner = () => runner.close();
  const restart = (name, store = opened.runners[0]) => void (runner = startRunner({ store, createLoop, name, ...TIMING, now: () => clock.at }));
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
  return { opened, ran, clock, settled, asks, answers, closeRunner, restart };
}

/** `store` with its command rows read `ms` late (commands, commandsOf); every other call its own. */
function slowRows(store, ms) {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "commands" || property === "commandsOf") return async (...args) => (await new Promise((resolve) => setTimeout(resolve, ms)), value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

test("a call the person declined, its tool's setting at allow by the next claim, never runs: the stored deny is read before the setting answers", async (t) => {
  const setting = { now: "ask" };
  const w = await parkedRun(t, { setting });
  const [ask] = await w.asks();
  setting.now = "allow";
  w.clock.at = ANSWERED_AT;
  await sendCommand(w.opened.server, "run-1", { kind: "deny", body: { approval: ask.callId, note: "not on a Friday" } });
  await w.settled("ended");
  assert.equal(w.ran.asked, 0, "the person's deny wins over the setting: it never ran");
  assert.deepEqual(await w.answers(), [{ callId: ask.callId, approved: false, decision: "deny", answeredAt: "2026-11-08T12:05:30.250Z", note: "not on a Friday" }]);
});

// The race the parked claim above can't reach (it reads its rows before pi's session recovers): a takeover. A runner
// claims the parked run and dies at once, so the person's deny is written and left untaken while the run reads running;
// once that claim's lease runs out, the next claim comes from running, and pi starts the call's task again while its
// session opens, before the runner hands the loop the stored deny. The setting at allow by then must not answer first.
test("a takeover that finds the person's deny untaken and the call's tool set to allow since: the deny wins, though pi starts the call's task while its session opens", async (t) => {
  const setting = { now: "ask" };
  const w = await parkedRun(t, { setting });
  const [ask] = await w.asks();
  await w.closeRunner();
  setting.now = "allow";
  w.clock.at = ANSWERED_AT;
  await sendCommand(w.opened.server, "run-1", { kind: "deny", body: { approval: ask.callId, note: "not on a Friday" } });
  // The runner that dies: its claim (the deny made the run claimable) moves the run to running, and nothing of it reads a
  // row or writes one again.
  assert.ok(await w.opened.server.claim("run-1", "runner-gone", { leaseMs: 60_000 }), "claimed by the runner that dies");
  // Its lease runs out on the store's clock: runner-b takes the run over, from running. Its reads of the run's rows come
  // late (a store slow to answer), so the session opens, and the call's task starts, before the deny reaches the loop.
  w.opened.clock.skewMs += 61_000;
  w.restart("runner-b", slowRows(w.opened.runners[0], 600));
  await w.settled("ended");
  assert.equal(w.ran.asked, 0, "the person's deny wins over the setting: it never ran");
  assert.deepEqual(await w.answers(), [{ callId: ask.callId, approved: false, decision: "deny", answeredAt: "2026-11-08T12:05:30.250Z", note: "not on a Friday" }]);
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
