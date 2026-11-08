// A loop whose claim was lost and that never settles (it ignores its stop and its signal) still takes one of the runner's
// loops until it does (the lead's read of #1969, P2-9): when the run is claimed again, the new loop is the stuck one's
// replacement in `runs`, but the stuck one is not forgotten, so the runner never holds more loops than `loops`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, observed, queue, recorder, sleep, stores, until } from "./runner-support.mjs";

const TIMING = { leaseMs: 600, renewEveryMs: 100, stopMarginMs: 200, pollMs: 20, commandPollMs: 20 };

test("a lost claim's loop that never settles keeps its slot when its run is claimed again: never more loops than `loops`", async (t) => {
  // Every loop here is stubborn: none settles until the test halts it, so every loop made is still running.
  const faux = fauxLoops({ stubborn: true, turnMs: 15 });
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop: faux.createLoop, name: "runner-a", loops: 2, ...TIMING });
  t.after(async () => {
    for (const loop of faux.loops) loop.halted = true;
    await runner.close();
  });
  await until(() => faux.loops.length === 1 && faux.loops[0].claim, "run-1's loop");
  const stuck = faux.loops[0];
  // Its renews fail: the runner stops the loop (claim lost), which ignores it and keeps going.
  record.blockRenew.add("runner-a");
  await until(() => stuck.stopCalls[0], "the runner stops the loop", TIMING.leaseMs * 3);
  record.blockRenew.delete("runner-a");
  // Past the lost claim's end the runner claims run-1 again: a second loop, the stuck one still running beside it.
  await until(() => faux.loops.length === 2, "run-1 claimed again", TIMING.leaseMs * 5);
  // Two loops run now, the runner's whole `loops`. Waiting runs must wait.
  await queue(opened.server, "run-2");
  await queue(opened.server, "run-3");
  await sleep(TIMING.leaseMs * 2);
  assert.ok(faux.loops.length <= 2, `at most 2 loops running at once, the stuck one counted: ${JSON.stringify(faux.loops.map((loop) => [loop.claim?.runId, loop.claim?.epoch]))}`);
  // Once it settles, its slot is free again.
  stuck.halted = true;
  const before = faux.loops.length;
  await until(() => faux.loops.length > before, "a new loop once the stuck one settled", TIMING.leaseMs * 5);
});
