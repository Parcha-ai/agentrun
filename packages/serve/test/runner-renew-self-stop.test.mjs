// A runner that cannot renew a claim stops that loop itself before the claim runs out (Solid Queue's rule: a process
// that cannot heartbeat stops its own work rather than waiting to be replaced). The loop is told to stop (claim-lost),
// its signal is aborted, and from then on the runner's own fence refuses its commits before they reach the store. The
// store's epoch fence stays the backstop, not the only guard. The loop here is stubborn (it ignores stop() and the
// signal and keeps committing), so what keeps its writes out is the runner, not the loop's manners.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fakeClock, fauxLoops, nextOrder, observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

// A lease no stall of a loaded machine runs out: the claim is lost only where a case loses it, at the claim deadline the
// test moves (fakeClock) or by the store's clock jumping past it. The renew tick is short, so a renew answered Fenced
// comes within one; only the lease is long.
const TIMING = { ...STEADY_LEASE, renewEveryMs: 100, pollMs: 20, commandPollMs: 20 };
/** The claim deadline, from the claim: its lease less the stop margin (RunnerOptions.stopMarginMs). */
const DEADLINE_MS = TIMING.leaseMs - TIMING.stopMarginMs;
const WAIT_MS = 10_000;

async function held(t, faux, timing = {}) {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const events = [];
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop: faux.createLoop, name: "runner-a", onEvent: (event) => events.push(event), ...TIMING, ...timing });
  t.after(async () => {
    for (const loop of faux.loops) loop.halted = true;
    await runner.close();
  });
  await until(() => record.commits.some((commit) => commit.epoch === 1), "the loop commits under its claim");
  return { ...opened, record, runner, events };
}

test("renews that fail: the loop is stopped at its claim deadline, before claimed_until, and nothing it commits after the stop lands", async (t) => {
  const faux = fauxLoops({ stubborn: true, turnMs: 15 });
  const clock = fakeClock();
  const { server, record, runner, events } = await held(t, faux, { clock });
  const loop = faux.loops[0];

  // Every renew fails from here (the store busy), so no answer of the store's moves the deadline or loses the claim: the
  // stop is the runner's own, at its deadline on the clock the test moves.
  record.blockRenew.add("runner-a");
  clock.advance(DEADLINE_MS - 1);
  assert.deepEqual(loop.stopCalls, [], "not stopped before its deadline");
  clock.advance(1);
  const stop = await until(() => loop.stopCalls[0], "the runner stops the loop at its claim deadline", WAIT_MS);

  assert.equal(stop.kind, "claim-lost");
  assert.ok(events.some((event) => event.type === "claim-lost" && event.why === "not-renewed"), `lost at its deadline, unrenewed: ${JSON.stringify(events)}`);
  const until_ = (await server.runs.get("run-1")).claimedUntil;
  assert.ok(stop.at < until_, `stopped ${until_ - stop.at} ms before the store's claimed_until (must be > 0)`);
  assert.equal(loop.deps.signal.aborted, true, "the loop's signal is aborted at the stop");
  // The stubborn loop keeps trying: every commit from the stop on is refused by the runner, never reaching the store.
  // Waited for by its event (a commit tried after the stop), never by the clock.
  const late = await until(() => {
    const tried = loop.commitErrors.filter((error) => error.startedOrder > stop.order);
    return tried.length > 0 && tried;
  }, "the loop tries to commit after the stop", WAIT_MS);
  // In the order things happened, not by the clock: a commit tried in the stop's own ms, before it, is not late.
  assert.deepEqual(record.commits.filter((commit) => commit.epoch === 1 && commit.startedOrder > stop.order), [], "no commit of epoch 1 started after the stop lands");
  assert.ok(late.every((error) => error.name === "ClaimLost"), `refused by the runner's fence, not the store's: ${JSON.stringify(late.slice(0, 3))}`);
  assert.deepEqual(runner.held().filter((claim) => claim.epoch === 1), [], "the runner no longer holds epoch 1's claim");
  // pi chains on commit's promise: the refusal is a rejected promise, never a throw out of the call itself.
  let pending;
  assert.doesNotThrow(() => (pending = loop.journal.commit([[]], () => {}, undefined)), "commit does not throw where it is called");
  await assert.rejects(pending, { name: "ClaimLost" });
});

test("a renew refused as Fenced (the store's clock jumped and another runner took the claim): the loop is stopped at once", async (t) => {
  const faux = fauxLoops({ stubborn: true, turnMs: 15 });
  // The runner claims at its start and polls no more: the jumped clock must not let it claim the run again itself.
  const { server, clock, record, events } = await held(t, faux, { pollMs: 60_000 });
  const loop = faux.loops[0];

  // The store's now jumps past the claim's until, and another runner claims the run: the epoch moves.
  clock.skewMs = TIMING.leaseMs * 2;
  const taken = await server.claim("run-1", "runner-z", { leaseMs: 60_000 });
  const movedOrder = nextOrder();
  assert.equal(taken?.epoch, 2, "the other runner's claim");
  // The next renew is answered Fenced, and the runner stops the loop on that answer: no deadline is reached (the lease is
  // long). Waited for by its event, never measured on the clock.
  const stop = await until(() => loop.stopCalls[0], "the runner stops the loop on the Fenced renew", WAIT_MS);
  assert.equal(stop.kind, "claim-lost");
  assert.ok(stop.order > movedOrder, "stopped after the fence moved");
  assert.ok(events.some((event) => event.type === "claim-lost" && event.why === "fenced"), `lost on the store's Fenced answer: ${JSON.stringify(events)}`);
  // Before the stop the store's fence refused them (Fenced); from the stop on, the runner's does.
  const late = await until(() => {
    const tried = loop.commitErrors.filter((error) => error.startedOrder > stop.order);
    return tried.length > 0 && tried;
  }, "the loop tries to commit after the stop", WAIT_MS);
  assert.ok(late.every((error) => error.name === "ClaimLost"), JSON.stringify(late.slice(0, 3)));
  assert.equal(record.commits.filter((commit) => commit.epoch === 1 && commit.startedOrder > movedOrder).length, 0, "epoch 1 wrote nothing after the move");
});
