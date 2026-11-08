// A runner that cannot renew a claim stops that loop itself before the claim runs out (Solid Queue's rule: a process
// that cannot heartbeat stops its own work rather than waiting to be replaced). The loop is told to stop (claim-lost),
// its signal is aborted, and from then on the runner's own fence refuses its commits before they reach the store. The
// store's epoch fence stays the backstop, not the only guard. The loop here is stubborn (it ignores stop() and the
// signal and keeps committing), so what keeps its writes out is the runner, not the loop's manners.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, sleep, storeDouble, until } from "./runner-support.mjs";

const TIMING = { leaseMs: 600, renewEveryMs: 100, stopMarginMs: 200, pollMs: 20, commandPollMs: 20 };

async function held(t, store, faux) {
  await store.runs.create("run-1");
  const runner = startRunner({ store, createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  t.after(async () => {
    for (const loop of faux.loops) loop.halted = true;
    await runner.close();
  });
  await until(() => store.commits.some((commit) => commit.epoch === 1), "the loop commits under its claim");
  return runner;
}

test("renews that fail: the loop is stopped before claimed_until, and nothing it commits after the stop lands", async (t) => {
  const store = storeDouble();
  const faux = fauxLoops({ stubborn: true, turnMs: 15 });
  const runner = await held(t, store, faux);
  const loop = faux.loops[0];

  store.blockRenew.add("runner-a");
  const lastUntil = (await store.runs.get("run-1")).claimedUntil;
  const stop = await until(() => loop.stopCalls[0], "the runner stops the loop", TIMING.leaseMs * 3);

  assert.equal(stop.kind, "claim-lost");
  assert.ok(stop.at < lastUntil, `stopped ${lastUntil - stop.at} ms before claimed_until (must be > 0)`);
  assert.equal(loop.deps.signal.aborted, true, "the loop's signal is aborted at the stop");
  // The stubborn loop keeps trying: every commit from the stop on is refused by the runner, never reaching the store.
  await sleep(TIMING.leaseMs);
  const after = store.commits.filter((commit) => commit.at >= stop.at);
  assert.deepEqual(after, [], "no commit lands after the stop");
  assert.ok(loop.commitErrors.length > 0, "the loop did try to commit after the stop");
  assert.ok(
    loop.commitErrors.every((error) => error.name === "ClaimLost"),
    `refused by the runner's fence, not the store's: ${JSON.stringify(loop.commitErrors.slice(0, 3))}`,
  );
  assert.deepEqual(runner.held(), [], "the runner no longer holds the run");
});

test("a renew refused as Fenced (another runner took the claim): the loop is stopped at once", async (t) => {
  const store = storeDouble();
  const faux = fauxLoops({ stubborn: true, turnMs: 15 });
  await held(t, store, faux);
  const loop = faux.loops[0];

  // Another runner's claim moved the epoch (as after a long pause of this one).
  const run = store.runsTableBump("run-1");
  const stop = await until(() => loop.stopCalls[0], "the runner stops the loop", TIMING.renewEveryMs * 4);
  assert.equal(stop.kind, "claim-lost");
  assert.ok(stop.at - run.bumpedAt <= TIMING.renewEveryMs * 2, `stopped ${stop.at - run.bumpedAt} ms after the fence moved`);
  await sleep(TIMING.renewEveryMs * 2);
  // Before the stop the store's fence refused them (Fenced); from the stop on, the runner's does.
  const late = loop.commitErrors.filter((error) => error.at > stop.at);
  assert.ok(late.length > 0 && late.every((error) => error.name === "ClaimLost"), JSON.stringify(late.slice(0, 3)));
  assert.equal(store.commits.filter((commit) => commit.epoch === 1 && commit.at >= run.bumpedAt).length, 0, "epoch 1 wrote nothing after the move");
});
