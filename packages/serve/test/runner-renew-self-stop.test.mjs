// A runner that cannot renew a claim stops that loop itself before the claim runs out (Solid Queue's rule: a process
// that cannot heartbeat stops its own work rather than waiting to be replaced). The loop is told to stop (claim-lost),
// its signal is aborted, and from then on the runner's own fence refuses its commits before they reach the store. The
// store's epoch fence stays the backstop, not the only guard. The loop here is stubborn (it ignores stop() and the
// signal and keeps committing), so what keeps its writes out is the runner, not the loop's manners.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, observed, queue, recorder, sleep, stores, until } from "./runner-support.mjs";

const TIMING = { leaseMs: 600, renewEveryMs: 100, stopMarginMs: 200, pollMs: 20, commandPollMs: 20 };

async function held(t, faux, timing = {}) {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop: faux.createLoop, name: "runner-a", ...TIMING, ...timing });
  t.after(async () => {
    for (const loop of faux.loops) loop.halted = true;
    await runner.close();
  });
  await until(() => record.commits.some((commit) => commit.epoch === 1), "the loop commits under its claim");
  return { ...opened, record, runner };
}

test("renews that fail: the loop is stopped before claimed_until, and nothing it commits after the stop lands", async (t) => {
  const faux = fauxLoops({ stubborn: true, turnMs: 15 });
  const { server, record, runner } = await held(t, faux);
  const loop = faux.loops[0];

  record.blockRenew.add("runner-a");
  const lastUntil = (await server.runs.get("run-1")).claimedUntil;
  const stop = await until(() => loop.stopCalls[0], "the runner stops the loop", TIMING.leaseMs * 3);

  assert.equal(stop.kind, "claim-lost");
  assert.ok(stop.at < lastUntil, `stopped ${lastUntil - stop.at} ms before claimed_until (must be > 0)`);
  assert.equal(loop.deps.signal.aborted, true, "the loop's signal is aborted at the stop");
  // The stubborn loop keeps trying: every commit from the stop on is refused by the runner, never reaching the store.
  await sleep(TIMING.leaseMs);
  // Once the claim has run out the run may be claimed again (by this runner too: its claims go through, only its renews
  // fail), at epoch 2 with a loop of its own; epoch 1's loop is the one that must write nothing.
  assert.deepEqual(record.commits.filter((commit) => commit.epoch === 1 && commit.startedAt >= stop.at), [], "no commit of epoch 1 started after the stop lands");
  // Commits tried from the stop on (one begun before it may be refused after it, by the store).
  const late = loop.commitErrors.filter((error) => error.startedAt >= stop.at);
  assert.ok(late.length > 0, "the loop did try to commit after the stop");
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
  const { server, clock, record } = await held(t, faux, { pollMs: 60_000 });
  const loop = faux.loops[0];

  // The store's now jumps past the claim's until, and another runner claims the run: the epoch moves.
  clock.skewMs = TIMING.leaseMs * 2;
  const taken = await server.claim("run-1", "runner-z", { leaseMs: 60_000 });
  const movedAt = Date.now();
  assert.equal(taken?.epoch, 2, "the other runner's claim");
  const stop = await until(() => loop.stopCalls[0], "the runner stops the loop", TIMING.renewEveryMs * 4);
  assert.equal(stop.kind, "claim-lost");
  assert.ok(stop.at - movedAt <= TIMING.renewEveryMs * 2, `stopped ${stop.at - movedAt} ms after the fence moved`);
  await sleep(TIMING.renewEveryMs * 2);
  // Before the stop the store's fence refused them (Fenced); from the stop on, the runner's does.
  const late = loop.commitErrors.filter((error) => error.startedAt > stop.at);
  assert.ok(late.length > 0 && late.every((error) => error.name === "ClaimLost"), JSON.stringify(late.slice(0, 3)));
  assert.equal(record.commits.filter((commit) => commit.epoch === 1 && commit.startedAt >= movedAt).length, 0, "epoch 1 wrote nothing after the move");
});
