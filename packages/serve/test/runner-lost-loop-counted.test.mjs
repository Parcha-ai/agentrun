// A loop whose claim was lost and that never settles (it ignores its stop and its signal) still takes one of the runner's
// loops until it does (the lead's read of #1969, P2-9): when the run is claimed again, the new loop is the stuck one's
// replacement in `runs`, but the stuck one is not forgotten, so the runner never holds more loops than `loops`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fakeClock, fauxLoops, observed, queue, recorder, sleep, STEADY_LEASE, stores, until } from "./runner-support.mjs";

// A lease no stall of a loaded machine runs out: the claim is lost where the case loses it, at the claim deadline the
// test moves (fakeClock), and the run is claimable again once the store's clock is moved past the lost claim's until.
const TIMING = { ...STEADY_LEASE, renewEveryMs: 100, pollMs: 20, commandPollMs: 20 };
const DEADLINE_MS = TIMING.leaseMs - TIMING.stopMarginMs;
const WAIT_MS = 10_000;

test("a lost claim's loop that never settles keeps its slot when its run is claimed again: never more loops than `loops`", async (t) => {
  // Every loop here is stubborn: none settles until the test halts it, so every loop made is still running.
  const faux = fauxLoops({ stubborn: true, turnMs: 15 });
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const clock = fakeClock();
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop: faux.createLoop, name: "runner-a", loops: 2, clock, ...TIMING });
  t.after(async () => {
    for (const loop of faux.loops) loop.halted = true;
    await runner.close();
  });
  await until(() => faux.loops.length === 1 && faux.loops[0].claim, "run-1's loop");
  const stuck = faux.loops[0];
  // Its renews fail, and its claim deadline passes on the clock the test moves: the runner stops the loop (claim lost),
  // which ignores it and keeps going.
  record.blockRenew.add("runner-a");
  clock.advance(DEADLINE_MS);
  await until(() => stuck.stopCalls[0], "the runner stops the loop", WAIT_MS);
  record.blockRenew.delete("runner-a");
  // Past the lost claim's end (the store's clock moved past its until) the runner claims run-1 again: a second loop, the
  // stuck one still running beside it.
  opened.clock.skewMs = TIMING.leaseMs * 2;
  await until(() => faux.loops.length === 2, "run-1 claimed again", WAIT_MS);
  // Two loops run now, the runner's whole `loops`. Waiting runs must wait: a free slot would take one at the next poll.
  // This wait can only miss a slot counted wrong, never fail a right one (nothing here runs out).
  await queue(opened.server, "run-2");
  await queue(opened.server, "run-3");
  await sleep(TIMING.pollMs * 10);
  assert.ok(faux.loops.length <= 2, `at most 2 loops running at once, the stuck one counted: ${JSON.stringify(faux.loops.map((loop) => [loop.claim?.runId, loop.claim?.epoch]))}`);
  // Once it settles, its slot is free again.
  stuck.halted = true;
  const before = faux.loops.length;
  await until(() => faux.loops.length > before, "a new loop once the stuck one settled", WAIT_MS);
});
