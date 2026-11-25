// A start that fails stops what it began: no interval it set is left firing on the store it closed. The paired-route tick
// (every PAIRED_ROUTE_MS), the sweep of runs no runner here can take and the local sources' sync are each set partway
// through a start; a start that failed after one of them once left it running for the life of the process, the route tick
// failing on the closed store every second. Counted through the process's own setInterval and clearInterval, never by
// waiting for a tick.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { FAUX, scratch, startServe } from "./support.mjs";

/** Each interval set while `start()` runs that is never cleared, by the place that set it. */
async function leftSet(t, start) {
  const set = t.mock.method(globalThis, "setInterval");
  const cleared = new Set();
  for (const name of ["clearInterval", "clearTimeout"]) {
    const original = globalThis[name];
    t.mock.method(globalThis, name, (handle) => (cleared.add(handle), original(handle)));
  }
  try {
    await start();
  } finally {
    t.mock.restoreAll();
  }
  return set.mock.calls.filter((call) => !cleared.has(call.result)).map((call) => `every ${call.arguments[1]} ms, set at ${call.stack.stack.split("\n").find((line) => line.includes("/dist/"))?.trim()}`);
}

test("a start that fails partway (a webhook try's bound it refuses) leaves no interval it set: the paired-route tick is cleared with the rest", async (t) => {
  const data = join(await scratch(t), "agents");
  const left = await leftSet(t, () => assert.rejects(startServe({ data, faux: FAUX, webhookTimeoutMs: 0 }), RangeError));
  assert.deepEqual(left, []);
});

test("a start that fails at its last step (its port is taken) leaves no interval it set: the paired-route tick is cleared with the rest", async (t) => {
  const taken = createServer();
  await new Promise((go) => taken.listen(0, "127.0.0.1", go));
  t.after(() => new Promise((go) => taken.close(go)));
  const data = join(await scratch(t), "agents");
  const left = await leftSet(t, () => assert.rejects(startServe({ data, faux: FAUX, port: taken.address().port }), (error) => error.code === "EADDRINUSE"));
  assert.deepEqual(left, []);
});
