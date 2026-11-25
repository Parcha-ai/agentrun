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
const { PAIRED_ROUTE_MS } = await import("../dist/workspace/paired-route.js");
const { openStore } = await import("../dist/store/index.js");

/** `data` with one paired computer in its store: a route tick then reads the paired computers, and after them the routes. */
async function withPaired(data) {
  const store = await openStore({ dataDir: data, role: "server" });
  try {
    await store.pairedComputers.addCode("pairing-1", "code-sha", Date.now() + 60_000);
    assert.equal(await store.pairedComputers.pair("code-sha", { id: "cmp-paired0000000000001", name: "desk-1", hello: { version: "1" }, labels: [], tokenSha256: "token-sha" }), true);
  } finally {
    await store.close();
  }
}

/** The intervals set while `start()` runs (with `tickAsCleared`, the paired-route tick runs once only, as its clear begins): `left`, each never cleared, and `late`, each cleared only once the store's
 *  close had begun (the first close of a store connection after the start's last interval was set), by where it was set. */
async function intervalsOf(t, start, { tickAsCleared = false } = {}) {
  const events = [];
  const ticks = new Map();
  const setInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (...args) => {
    // With `tickAsCleared`, the route tick runs only then: its first tick, which reads the paired computers, then the routes.
    const routeTick = tickAsCleared && args[1] === PAIRED_ROUTE_MS;
    const handle = routeTick ? setInterval(() => undefined, args[1]) : setInterval(...args);
    if (routeTick) ticks.set(handle, args[0]);
    events.push({ set: handle, at: new Error().stack.split("\n").find((line) => line.includes("/dist/"))?.trim(), every: args[1] });
    return handle;
  });
  for (const name of ["clearInterval", "clearTimeout"]) {
    const original = globalThis[name];
    t.mock.method(globalThis, name, (handle) => {
      // The route tick fires just as the failed start's stop clears it: a tick in flight as the stops begin.
      if (tickAsCleared && ticks.has(handle)) ticks.get(handle)();
      events.push({ cleared: handle });
      return original(handle);
    });
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

test("a route tick still running as a failed start stops is waited out before its store closes: it never reads a closed store", async (t) => {
  const taken = createServer((socket) => socket.destroy());
  await new Promise((go) => taken.listen(0, "127.0.0.1", go));
  t.after(() => new Promise((go) => taken.close(go)));
  const data = join(await scratch(t), "agents");
  await withPaired(data);
  const lines = [];
  await intervalsOf(t, () => assert.rejects(startServe({ data, faux: FAUX, port: taken.address().port, log: (line) => void lines.push(line) }), (error) => error.code === "EADDRINUSE"), { tickAsCleared: true });
  // Its two reads, one after the other, both land before the store's close begins: neither finds the store closed.
  await new Promise((go) => setImmediate(go));
  assert.deepEqual(lines.filter((line) => line.includes("computer_route_tick_failed")), []);
});
