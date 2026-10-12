import assert from "node:assert/strict";
import { test } from "node:test";
import { LoadGate } from "../obsession/load-gate.ts";

const loaded = (ms: number) => ({ type: "model-loaded" as const, load_ms: ms });
const failed = { type: "model-failed" as const, reason: "x" };

test("a load that arrives before the agent is home waits, and is applied once when it is home", () => {
  const g = new LoadGate();
  assert.equal(g.offer(loaded(5000), false, false), null);
  assert.equal(g.release(false), null, "still not home");
  assert.deepEqual(g.release(true)?.m, loaded(5000));
  assert.equal(g.release(true), null, "once");
  assert.deepEqual(g.offer(loaded(6000), false, true)?.m, loaded(6000), "when the agent is already home it is said at once");
});

// Greptile on #140: an early load kept waiting could replace a later failure when the agent came home, so the banner said loaded after a failure.
test("a failure that arrives after an early load clears it: the load never comes back over the failure", () => {
  const g = new LoadGate();
  g.offer(loaded(5000), false, false);
  assert.deepEqual(g.offer(failed, false, false)?.m, failed, "the failure is applied now, home or not");
  assert.equal(g.release(true), null, "the held load is gone");
});

test("a newer load replaces the held one, and a load that can be said now clears what was held", () => {
  const g = new LoadGate();
  g.offer(loaded(5000), false, false);
  g.offer(loaded(7000), false, false);
  assert.deepEqual(g.release(true)?.m, loaded(7000), "the newer one");
  g.offer(loaded(8000), false, false);
  assert.deepEqual(g.offer(loaded(9000), false, true)?.m, loaded(9000));
  assert.equal(g.release(true), null, "the older held load did not come back after the newer one was said");
});

test("other model messages pass through untouched, the scripted flag travels with the held load, and a reset forgets", () => {
  const g = new LoadGate();
  assert.deepEqual(g.offer({ type: "model-download", done_chunks: 1, total_chunks: 2 }, false, false)?.m, { type: "model-download", done_chunks: 1, total_chunks: 2 });
  g.offer(loaded(5000), true, false);
  assert.equal(g.release(true)?.scripted, true);
  g.offer(loaded(5000), false, false);
  g.reset();
  assert.equal(g.release(true), null);
});
