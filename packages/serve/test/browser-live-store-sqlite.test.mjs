// The live viewers' hand-over (browser-live.ts) on the real store (SqliteStore's browser_viewers), under a claim the store
// hands out (runs.claimMany): the runner's put and drop, the server's reads, the fence, the sealed column and the end's
// purge, end to end through the store. The unit tests (browser-live-store.test.mjs) run the same calls on the fake.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { dropLiveViewer, liveViewerById, putLiveViewer, readLiveViewers } from "../dist/browser-live.js";
import { queued, storeOn } from "./store-helpers.mjs";

/** A test seal key, no real one. */
const KEY = randomBytes(32);
const handover = (tag) => ({ port: 40000, id: randomBytes(16).toString("base64url"), token: randomBytes(32).toString("base64url"), tag });

/** Every column of every browser_viewers row of `runId`, raw, as the store's file holds it. */
function rawRows(file, runId) {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  try {
    return db.prepare("SELECT * FROM browser_viewers WHERE run_id = ? ORDER BY tag").all(runId);
  } finally {
    db.close();
  }
}
/** Whether any column of `rows` holds `text`, as text or as bytes. */
const holds = (rows, text) => rows.some((row) => Object.values(row).some((value) => (value instanceof Uint8Array ? Buffer.from(value).includes(text) : String(value).includes(text))));

test("on the real store, under a claim from runs.claimMany: put, read, read by id and drop round trip; a stale claim's put answers false and writes nothing; no column holds the token's plaintext; the run's end purges the rows", async (t) => {
  const { store, clock, file } = await storeOn(t);
  await queued(store, "run-1");
  const [first] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  assert.equal(first?.runId, "run-1");

  // The round trip: the store stamps the time, newest first, each token opened.
  const a = handover("ar-run-1-1");
  const b = handover("ar-run-1-2");
  assert.equal(await putLiveViewer(store, KEY, first, a), true);
  clock.now += 10;
  assert.equal(await putLiveViewer(store, KEY, first, b), true);
  const strip = ({ port, id, token, tag }) => ({ port, id, token, tag });
  const read = await readLiveViewers(store, KEY, "run-1");
  assert.deepEqual(read.map(strip), [b, a]);
  assert.deepEqual(read.map((v) => v.at), [clock.now, clock.now - 10], "at the store's clock");
  assert.deepEqual(strip(await liveViewerById(store, KEY, "run-1", a.id)), a);
  assert.deepEqual(await readLiveViewers(store, randomBytes(32), "run-1"), [], "under another key no seal opens: no viewer");

  // The token's plaintext is in no column of the store's rows.
  const rows = rawRows(file, "run-1");
  assert.equal(rows.length, 2);
  for (const { token } of [a, b]) assert.equal(holds(rows, token), false, "the row holds the sealed token alone");

  // A session's release drops its own row.
  await dropLiveViewer(store, first, b.tag);
  assert.deepEqual((await readLiveViewers(store, KEY, "run-1")).map((v) => v.tag), [a.tag]);

  // A stale claim: the run released and claimed again, the first claim's put answers false and writes nothing.
  await store.release(first);
  const [second] = await store.runs.claimMany("runner-b", 1, { leaseMs: 60_000 });
  assert.ok(second && second.epoch > first.epoch, "claimed again at a newer epoch");
  const stale = handover("ar-run-1-3");
  assert.equal(await putLiveViewer(store, KEY, first, stale), false, "fenced");
  assert.equal(holds(rawRows(file, "run-1"), stale.id), false, "nothing of it written");
  const c = handover("ar-run-1-4");
  assert.equal(await putLiveViewer(store, KEY, second, c), true);
  assert.deepEqual((await readLiveViewers(store, KEY, "run-1")).map(strip), [c]);

  // The run's end purges its rows, in its end commit.
  await store.runs.update(second, { state: "ended" });
  assert.deepEqual(rawRows(file, "run-1"), [], "gone with the end");
  assert.deepEqual(await readLiveViewers(store, KEY, "run-1"), []);
});
