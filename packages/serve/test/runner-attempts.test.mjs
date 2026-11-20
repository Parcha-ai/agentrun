// Each claim of a run is an attempt at its turn (store run_attempts), and a run's usage lines say which attempt each charge
// was made in. A runner's close mid-turn (what its process does on SIGTERM: cli.ts, runner/main.ts) drains the run and
// hands it back; the claim that takes it over works the same turn again, attempt 2, cause `drain`, and every request the
// first attempt made is the infrastructure's cost (`billable: false`), summed in `infra_usd`. A run no attempt of which was
// cut reads attempt 1, billable, and `infra_usd` 0. A runner that dies mid-turn leaves its claim to lapse: the next claim's
// cause is `crash`. Faux loops book model requests into the run's journal as the runner books them (runner.request and
// runner.turn in the harness's session); the expected lines are worked out by hand from what each attempt booked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { startRunner } from "../dist/runner/runner.js";
import { runUsageOverStore } from "../dist/run-usage.js";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const ROOT = 1;
const RUN = "run-1";
/** No poll after a runner's first (which claims the run): a close then has no claim in flight to wait on. */
const TIMING = { ...STEADY_LEASE, pollMs: 25, commandPollMs: 20 };
const micro = (usd) => (usd === null ? null : Math.round(usd * 1e6));

/**
 * Loops that book `plan[n]` (USD per model request) in the n-th claim of the run, each request in the harness's session
 * (its conversation made by the first claim, named on the root by its session key), then hold the turn: a claim whose
 * plan says `end` ends the run in its last commit; any other holds until it is stopped (a shutdown: interrupted). `claims`
 * keeps each claim the loops were started on, `booked` how many claims have booked.
 */
function bookingLoops(plan) {
  const claims = [];
  const state = { session: undefined, turn: 0, booked: 0 };
  const createLoop = (deps) => {
    let stopNow;
    const stopped = new Promise((resolve) => (stopNow = resolve));
    const loop = {
      async start(claim) {
        const n = claims.push(claim) - 1;
        const step = plan[n] ?? { usd: [], end: true };
        const journal = deps.journal(claim);
        const writes = [];
        if (state.session === undefined) {
          state.session = await journal.mintId();
          writes.push({ type: "conversation", value: { id: ROOT } }, { type: "conversation", value: { id: state.session } });
          writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.session.key", data: { key: "harness", conversation: state.session } } });
        }
        for (const usd of step.usd) {
          const turn = ++state.turn;
          writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: state.session, kind: "runner.request", data: { turn, model: "m" } } });
          writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: state.session, kind: "runner.turn", data: { turn, usd, bookedUsd: usd, tableUsd: usd, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, rule: "answered" } } });
        }
        if (step.end) {
          const id = await journal.mintId();
          journal.stage({ run: { state: "ended" }, effect: id });
          writes.push({ type: "entry", value: { id, conversationId: ROOT, kind: "message" } });
        }
        await commitWrites(journal, writes, BACKGROUND_CONTEXT);
        state.booked += 1;
        if (step.end) return { state: "ended" };
        await stopped;
        return { state: "interrupted" };
      },
      async command() {
        return { taken: true };
      },
      async stop() {
        stopNow();
      },
    };
    return loop;
  };
  return { claims, state, createLoop };
}

/** The runner `name` on `store` with `loops`, closed at the test's end. */
function runnerOn(t, store, loops, name, extra = {}) {
  const runner = startRunner({ store, createLoop: loops.createLoop, name, live: false, ...TIMING, ...extra });
  t.after(() => runner.close());
  return runner;
}

const rested = (server) => until(async () => {
  const row = await server.runs.get(RUN);
  return row.state === "ended" && row.runner === null && row;
}, "the run ended and was let go", 20_000);

test("a runner's close (SIGTERM) mid-turn hands the run back: the next claim is attempt 2 of the same turn, cause drain; attempt 1's lines are not billable, and infra_usd is their sum", async (t) => {
  const { server, runners: [a, b] } = await stores({ runners: 2 });
  await queue(server, RUN);
  // Attempt 1 books two requests ($0.01 and $0.02) and is cut mid-turn; attempt 2 books the turn again ($0.04) and ends.
  const loops = bookingLoops([{ usd: [0.01, 0.02] }, { usd: [0.04], end: true }]);
  const first = runnerOn(t, a, loops, "runner-a", { drainMs: 50 });
  await until(() => loops.state.booked === 1, "attempt 1 booked its requests");
  await first.close();
  assert.deepEqual([(await server.runs.get(RUN)).state, (await server.runs.get(RUN)).runner], ["running", null], "handed back still running");
  runnerOn(t, b, loops, "runner-b");
  await rested(server);

  assert.deepEqual(loops.claims.map((claim) => [claim.runner, claim.turn, claim.attempt]), [["runner-a", 1, 1], ["runner-b", 1, 2]], "the claim says its turn and attempt");
  const attempts = await server.runAttempts.forRun(RUN);
  assert.deepEqual(attempts.map((row) => [row.runner, row.turn, row.attempt, row.cause, row.cut, row.from]), [["runner-a", 1, 1, null, "drain", "queued"], ["runner-b", 1, 2, "drain", null, "running"]]);

  const usage = await runUsageOverStore(server, RUN);
  const lines = usage.lines.map((line) => [line.meter, line.model, line.attempt, line.billable, line.requests, micro(line.usd)]);
  assert.deepEqual(lines, [["tokens", "m", 1, false, 2, micro(0.03)], ["tokens", "m", 2, true, 1, micro(0.04)]], "a line per attempt: the cut one's two requests, then the redo's one");
  const cut = usage.lines.filter((line) => !line.billable);
  assert.equal(micro(usage.infra_usd), micro(cut.reduce((sum, line) => sum + line.usd, 0)), "infra_usd is the sum of the lines that are not billable");
  assert.equal(micro(usage.infra_usd), micro(0.03));
  assert.equal(micro(usage.total.usd), micro(0.07), "total still holds every line: nothing is charged differently");
});

test("a run whose turn no claim cut: one attempt, its lines billable, infra_usd 0", async (t) => {
  const { server, runners: [a] } = await stores();
  await queue(server, RUN);
  const loops = bookingLoops([{ usd: [0.01, 0.02], end: true }]);
  runnerOn(t, a, loops, "runner-a");
  await rested(server);
  const attempts = await server.runAttempts.forRun(RUN);
  assert.deepEqual(attempts.map((row) => [row.turn, row.attempt, row.cause, row.cut]), [[1, 1, null, null]]);
  const usage = await runUsageOverStore(server, RUN);
  assert.deepEqual(usage.lines.map((line) => [line.attempt, line.billable, micro(line.usd)]), [[1, true, micro(0.03)]]);
  assert.equal(usage.infra_usd, 0);
});

test("a runner that dies mid-turn (no release) leaves its claim to lapse: the claim that takes the run over is attempt 2, cause crash", async (t) => {
  const { server, runners: [a, b] } = await stores({ runners: 2 });
  await queue(server, RUN);
  const loops = bookingLoops([{ usd: [0.01] }, { usd: [0.01], end: true }]);
  const short = { leaseMs: 400, renewEveryMs: 100, stopMarginMs: 100 };
  const first = runnerOn(t, a, loops, "runner-a", short);
  await until(() => loops.state.booked === 1, "attempt 1 booked");
  first.kill();
  runnerOn(t, b, loops, "runner-b", short);
  await rested(server);
  const attempts = await server.runAttempts.forRun(RUN);
  assert.deepEqual(attempts.map((row) => [row.runner, row.turn, row.attempt, row.cause, row.cut]), [["runner-a", 1, 1, null, null], ["runner-b", 1, 2, "crash", null]]);
  const usage = await runUsageOverStore(server, RUN);
  assert.deepEqual(usage.lines.map((line) => [line.attempt, line.billable]), [[1, false], [2, true]]);
  assert.equal(micro(usage.infra_usd), micro(0.01));
});

test("a lapse its runner lived to say reads lease_lapse, on the cut attempt and the cause of the one after it, whichever was written first", async (t) => {
  const { server, runners: [a] } = await stores();
  await queue(server, RUN);
  const one = await a.claim(RUN, "runner-a", { leaseMs: 1 });
  await until(async () => (await server.runs.claimable()).includes(RUN), "the lease ran out");
  const two = await a.claim(RUN, "runner-b");
  assert.deepEqual([two.turn, two.attempt], [1, 2]);
  assert.equal((await server.runAttempts.forRun(RUN))[1].cause, "crash", "read as a crash until its runner says otherwise");
  await a.runAttempts.lapsed(RUN, one.epoch);
  await a.runAttempts.lapsed(RUN, one.epoch);
  assert.deepEqual((await server.runAttempts.forRun(RUN)).map((row) => [row.attempt, row.cause, row.cut]), [[1, null, "lease_lapse"], [2, "lease_lapse", null]], "idempotent");
});

test("a claim that does not take over a cut turn starts the run's next turn, attempt 1: a park's resume, a release with nothing cut", async (t) => {
  const { server, runners: [a] } = await stores();
  await queue(server, RUN);
  const one = await a.claim(RUN, "runner-a");
  await a.release(one, { state: "parked", wakeAt: 0 });
  const two = await a.claim(RUN, "runner-a");
  assert.equal(two.from, "parked");
  // A release that says nothing cut (an older runner's, or a follow-up's reopen of an ended run) is a new turn too.
  await a.release(two, {});
  const three = await a.claim(RUN, "runner-a");
  assert.equal(three.from, "running");
  await a.release(three, { cut: "retry" });
  const four = await a.claim(RUN, "runner-a");
  assert.deepEqual([one, two, three, four].map((claim) => [claim.turn, claim.attempt]), [[1, 1], [2, 1], [3, 1], [3, 2]]);
  const rows = await server.runAttempts.forRun(RUN);
  assert.deepEqual(rows.map((row) => [row.turn, row.attempt, row.cause, row.cut]), [[1, 1, null, null], [2, 1, null, null], [3, 1, null, "retry"], [3, 2, "retry", null]]);
  assert.ok(rows.every((row, i) => i === 0 || row.journalFrom >= rows[i - 1].journalFrom), "each claim's first journal id is at or after the one before");
});
