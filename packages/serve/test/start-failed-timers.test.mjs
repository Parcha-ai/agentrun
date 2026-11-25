// A start that fails stops what it began: no interval it set is left firing on the store it closed, and each is cleared
// before that store's close begins, so no tick or sweep reads a closing store. The paired-route tick (every
// PAIRED_ROUTE_MS), the uploads' sweep, the sweep of runs no runner here can take and the local sources' sync are each set
// partway through a start; a start that failed after one of the last three once left it running for the life of the
// process, the route tick failing on the closed store every second, and the uploads' sweep was cleared only after the
// store's close. Counted through the process's own setInterval and clearInterval and the store
// connection's close, in the order they ran, never by waiting for a tick.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { FAUX, scratch, startServe } from "./support.mjs";

const { Connection } = await import("../dist/store/sqlite/connection.js");

/** The intervals set while `start()` runs: `left`, each never cleared, and `late`, each cleared only once the store's
 *  close had begun (the first close of a store connection after the start's last interval was set), by where it was set. */
async function intervalsOf(t, start) {
  const events = [];
  const setInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (...args) => {
    const handle = setInterval(...args);
    events.push({ set: handle, at: new Error().stack.split("\n").find((line) => line.includes("/dist/"))?.trim(), every: args[1] });
    return handle;
  });
  for (const name of ["clearInterval", "clearTimeout"]) {
    const original = globalThis[name];
    t.mock.method(globalThis, name, (handle) => (events.push({ cleared: handle }), original(handle)));
  }
  const close = Connection.prototype.close;
  t.mock.method(Connection.prototype, "close", function () {
    events.push({ closed: true });
    return close.call(this);
  });
  try {
    await start();
  } finally {
    t.mock.restoreAll();
  }
  const lastSet = events.findLastIndex((event) => "set" in event);
  const storeClosed = events.findIndex((event, index) => index > lastSet && event.closed);
  const clearedAt = (handle) => events.findIndex((event) => event.cleared === handle);
  const named = ({ every, at }) => `every ${every} ms, set ${at}`;
  const sets = events.filter((event) => "set" in event);
  return {
    storeClosed: storeClosed !== -1,
    left: sets.filter((event) => clearedAt(event.set) === -1).map(named),
    late: sets.filter((event) => clearedAt(event.set) > storeClosed).map(named),
  };
}

test("a start that fails partway (a webhook try's bound it refuses) leaves no interval it set, each cleared before its store closes: the paired-route tick with the rest", async (t) => {
  const data = join(await scratch(t), "agents");
  const { storeClosed, left, late } = await intervalsOf(t, () => assert.rejects(startServe({ data, faux: FAUX, webhookTimeoutMs: 0 }), RangeError));
  assert.ok(storeClosed, "the failed start closed its store");
  assert.deepEqual(left, [], "none is left set");
  assert.deepEqual(late, [], "none is cleared after the store's close begins");
});

test("a start that fails at its last step (its port is taken) leaves no interval it set, each cleared before its store closes: the paired-route tick with the rest", async (t) => {
  // Any connection it takes is ended at once: its close never waits on one (another process may dial a port it reused).
  const taken = createServer((socket) => socket.destroy());
  await new Promise((go) => taken.listen(0, "127.0.0.1", go));
  t.after(() => new Promise((go) => taken.close(go)));
  const data = join(await scratch(t), "agents");
  const { storeClosed, left, late } = await intervalsOf(t, () => assert.rejects(startServe({ data, faux: FAUX, port: taken.address().port }), (error) => error.code === "EADDRINUSE"));
  assert.ok(storeClosed, "the failed start closed its store");
  assert.deepEqual(left, [], "none is left set");
  assert.deepEqual(late, [], "none is cleared after the store's close begins");
});
