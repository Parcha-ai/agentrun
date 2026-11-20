// The store's side of the capacity read (GET /v2/capacity, capacity.ts): Runners.capacity counts the runs a runner may
// claim now (the claim's own rule) and the runs each runner's live claims hold, on the deadlines' clock; a release that
// leaves its run running is a hand-back, kept in hand_backs in the same write and counted within a window; and a runner's
// row says its version and slots. On SQLite by default, on Postgres with AGENTRUN_TEST_PG_URL (store-target.mjs).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { StoreAwaitsServer } from "../dist/store/store.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { queued, storeOn, T0 } from "./store-helpers.mjs";
import { sqliteOnly } from "./store-target.mjs";

const LEASE = 30_000;
const MINUTE = 60_000;

/** The capacity as plain values: the held map as an object. */
async function capacityOf(store, windowMs = 15 * MINUTE) {
  const read = await store.runners.capacity(windowMs);
  return { at: read.at, queued: read.queued, held: Object.fromEntries(read.held), handBacks: read.handBacks };
}

test("an empty store has nothing queued, nothing held and no hand-back", async (t) => {
  const { store } = await storeOn(t);
  assert.deepEqual(await capacityOf(store), { at: T0, queued: 0, held: {}, handBacks: 0 });
});

test("queued counts the runs a runner may claim; held counts each runner's live claims", async (t) => {
  const { store, clock } = await storeOn(t);
  for (const id of ["run-1", "run-2", "run-3", "run-4"]) await queued(store, id);
  assert.deepEqual(await capacityOf(store), { at: T0, queued: 4, held: {}, handBacks: 0 }, "four queued, none held");
  const a1 = await store.claim("run-1", "runner-a", { leaseMs: LEASE });
  const a2 = await store.claim("run-2", "runner-a", { leaseMs: LEASE });
  await store.claim("run-3", "runner-b", { leaseMs: LEASE });
  assert.deepEqual(await capacityOf(store), { at: T0, queued: 1, held: { "runner-a": 2, "runner-b": 1 }, handBacks: 0 });
  // runner-b's lease runs out: its run is held by none and waits for a claim; runner-a's renewed claims still hold.
  clock.now = T0 + 20_000;
  await store.renewMany([a1, a2], { leaseMs: LEASE });
  clock.now = T0 + LEASE + 1;
  assert.deepEqual(await capacityOf(store), { at: T0 + LEASE + 1, queued: 2, held: { "runner-a": 2 }, handBacks: 0 }, "a run whose claim ran out is waiting, not held");
});

test("a release that leaves the run running is a hand-back; a park, or a backoff not yet passed, is counted as such", async (t) => {
  const { store, clock } = await storeOn(t);
  for (const id of ["run-1", "run-2", "run-3"]) await queued(store, id);
  const one = await store.claim("run-1", "runner-a", { leaseMs: LEASE });
  const two = await store.claim("run-2", "runner-a", { leaseMs: LEASE });
  const three = await store.claim("run-3", "runner-a", { leaseMs: LEASE });
  assert.deepEqual(await capacityOf(store), { at: T0, queued: 0, held: { "runner-a": 3 }, handBacks: 0 });
  // A drain's hand-back: released running, at once claimable by another runner.
  await store.release(one, {});
  // A loop that closed itself: released running with a backoff, a hand-back, but not claimable until the backoff passes.
  await store.release(two, { backoffUntil: T0 + 5_000 });
  // A park: no hand-back.
  await store.release(three, { state: "parked" });
  assert.deepEqual(await capacityOf(store), { at: T0, queued: 1, held: {}, handBacks: 2 }, "two hand-backs; one run claimable now, the other after its backoff, the parked one waits for a wake");
  clock.now = T0 + 5_000;
  assert.equal((await capacityOf(store)).queued, 2, "the backoff passed: claimable");
});

test("hand-backs are counted within the window asked for, and kept a day", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store, "run-1");
  const first = await store.claim("run-1", "runner-a", { leaseMs: LEASE });
  await store.release(first, {});
  clock.now = T0 + 20 * MINUTE;
  const second = await store.claim("run-1", "runner-b", { leaseMs: LEASE });
  await store.release(second, {});
  assert.equal((await capacityOf(store, 15 * MINUTE)).handBacks, 1, "the last 15 minutes hold the second alone");
  assert.equal((await capacityOf(store, 30 * MINUTE)).handBacks, 2, "the last 30 minutes hold both");
  // A day and more later, the next hand-back's write removes the rows older than a day: a day's window counts it alone.
  clock.now = T0 + 25 * 60 * MINUTE;
  const third = await store.claim("run-1", "runner-a", { leaseMs: LEASE });
  await store.release(third, {});
  assert.equal((await capacityOf(store, 25 * 60 * MINUTE + MINUTE)).handBacks, 1, "the older rows were removed");
});

test("a run's end is no hand-back, and a purge removes its hand-backs", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const first = await store.claim("run-1", "runner-a", { leaseMs: LEASE });
  await store.release(first, {});
  const second = await store.claim("run-1", "runner-a", { leaseMs: LEASE });
  await store.runs.update(second, { state: "ended", summary: "done" });
  await store.release(second, {});
  assert.equal((await capacityOf(store)).handBacks, 1, "the end, and a release after it, added none");
  await store.runs.purge("run-1");
  assert.equal((await capacityOf(store)).handBacks, 0, "purged with its run");
});

test("a runner's row says its version and slots; a row put without them says neither", async (t) => {
  const { store } = await storeOn(t);
  await store.runners.put({ runner: "runner-a", incarnation: "i-1", refused: null, version: "9.9.9", slots: 25 });
  await store.runners.put({ runner: "runner-b", incarnation: "i-2", refused: null });
  const rows = (await store.runners.live(30_000)).map(({ runner, version, slots }) => ({ runner, version, slots }));
  assert.deepEqual(rows, [{ runner: "runner-a", version: "9.9.9", slots: 25 }, { runner: "runner-b", version: null, slots: null }]);
  // A renewal keeps them; a put again by a new incarnation says its own.
  assert.equal(await store.runners.renew("runner-a", "i-1", null), true);
  await store.runners.put({ runner: "runner-a", incarnation: "i-3", refused: null, version: "10.0.0", slots: 4 });
  assert.deepEqual((await store.runners.list()).map(({ runner, version, slots }) => ({ runner, version, slots })), [{ runner: "runner-a", version: "10.0.0", slots: 4 }, { runner: "runner-b", version: null, slots: null }]);
});

test("a SQLite store an earlier build of this version made gets each runner's version and slots and the hand-backs at the server's open; a runner waits for it", sqliteOnly("the in-place upgrade at a server's open"), async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-capacity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  // An earlier build's store: this version's schema without the columns and table it lacked, one runner's row in it.
  await (await openSqliteStore({ file, role: "server" })).close();
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE hand_backs; ALTER TABLE runners DROP COLUMN version; ALTER TABLE runners DROP COLUMN slots; INSERT INTO runners (runner, incarnation, refused, seen_at) VALUES ('old', 'i-0', NULL, 1)");
  db.close();
  await assert.rejects(openSqliteStore({ file, role: "runner" }), (error) => error instanceof StoreAwaitsServer && /runners\.version, runners\.slots, hand_backs/.test(error.message), "a runner waits for the server");
  const server = await openSqliteStore({ file, role: "server" });
  try {
    assert.deepEqual((await server.runners.list()).map(({ runner, version, slots }) => ({ runner, version, slots })), [{ runner: "old", version: null, slots: null }], "the earlier row kept, its version and slots unknown");
    assert.equal((await server.runners.capacity(MINUTE)).handBacks, 0, "hand_backs made");
  } finally {
    await server.close();
  }
  const runner = await openSqliteStore({ file, role: "runner" });
  await runner.close();
});
