// A run whose loop ends interrupted on its own (its Session closed itself, with no stop asked of it) is released with a
// doubling backoff, so a Harness that keeps closing is not claimed again about every poll, forever (the lead's read of
// #1969, P2-10). A loop the runner stopped (a shutdown) is released at once, for another runner to take over.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { observed, queue, recorder, sleep, STEADY_LEASE, stores } from "./runner-support.mjs";

const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 50 };
const BACKOFF_MS = 150;

/** Loops whose every start ends interrupted at once, as a Session that closes on its own. */
const closingLoops = () => {
  const starts = [];
  return {
    starts,
    createLoop: () => ({
      start: async (claim) => (starts.push({ epoch: claim.epoch, at: Date.now() }), { state: "interrupted" }),
      command: async () => ({ refused: "not in this test" }),
      stop: async () => {},
    }),
  };
};

test("a run whose loop keeps ending interrupted on its own is claimed again only after a doubling backoff", async (t) => {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const loops = closingLoops();
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop: loops.createLoop, name: "runner-a", interruptBackoffMs: BACKOFF_MS, ...TIMING });
  t.after(() => runner.close());
  await sleep(BACKOFF_MS * 7);
  const gaps = loops.starts.slice(1).map((start, i) => start.at - loops.starts[i].at);
  // 150, 300, 600 ms apart: at most four starts in ~1 s, where a release with no backoff claims it every poll (20 ms).
  assert.ok(loops.starts.length <= 4, `claimed ${loops.starts.length} times in ${BACKOFF_MS * 7} ms: gaps ${JSON.stringify(gaps)}`);
  for (const [i, gap] of gaps.entries()) assert.ok(gap >= BACKOFF_MS * 2 ** i - 20, `gap ${i + 1} is ${gap} ms, at least ${BACKOFF_MS * 2 ** i}`);
  assert.equal((await opened.server.runs.get("run-1")).state, "running", "never failed for it: a backoff, not an end");
});
