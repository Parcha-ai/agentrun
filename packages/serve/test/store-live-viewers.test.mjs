// The store's live viewers (store.liveViewers): each open browser session's viewer hand-over, one row per run and
// session tag, its token sealed under the seal key at its own column (sealedAt.liveViewer). The runner puts and drops
// them under its claim; the server reads them. The contract browser-live.ts is written against:
// - put: the claim's fence (its epoch and its lease, on the store's clock), upsert on (run_id, tag), `at` the store's
//   clock, runner and epoch the claim's; false when fenced, and nothing written;
// - drop: the claim's epoch alone, as run_live's drop; one tag or all of the run's rows;
// - of: newest first, only rows of the run's epoch, under a live lease, by the run's runner;
// - the rows go with the run's end (its end commit), with a take or reclaim of the run (a newer epoch), and with the run.
// The table's rows are read raw here (node:sqlite on the store's file) to tell a row not written from one not shown.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";

const { sealedAt, sealColumn, unsealColumn } = await import("../dist/store/seal.js");
const { readRun } = await import("../dist/store-reads/runs.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

const KEY = randomBytes(32);
const TOKEN = `not-a-secret-${"viewer-token-0123456789"}`;
const viewer = (runId, tag, { port = 47_001, id = `viewer-${tag}` } = {}) => ({ tag, port, id, sealed: sealColumn(KEY, sealedAt.liveViewer(runId, tag), TOKEN) });

/** The table's rows for `runId`, raw: what the store holds, whatever of() shows. */
function rawRows(file, runId) {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  try {
    return db.prepare("SELECT tag, port, viewer_id, at, runner, epoch FROM browser_viewers WHERE run_id = ? ORDER BY tag").all(runId);
  } finally {
    db.close();
  }
}

test("a put under the claim is the row of(): upserted on its tag, at the store's clock, newest first, its runner the claim's", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main")), true);
  clock.now += 10;
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "second", { port: 47_002 })), true);
  clock.now += 10;
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main", { port: 47_003, id: "viewer-main-2" })), true, "the same tag again: upserted");
  const rows = await store.liveViewers.of("run-1");
  assert.deepEqual(rows.map(({ tag, port, id, at, runner }) => ({ tag, port, id, at, runner })), [
    { tag: "main", port: 47_003, id: "viewer-main-2", at: clock.now, runner: "runner-a" },
    { tag: "second", port: 47_002, id: "viewer-second", at: clock.now - 10, runner: "runner-a" },
  ], "newest first; the upsert moved its row's at");
  assert.ok(rows.every((row) => row.sealed instanceof Uint8Array && !("epoch" in row)), "its sealed bytes, and no epoch in the row");
});

test("a stale epoch's put is refused: false, and nothing of it written", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const old = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.release(old);
  const current = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  assert.equal(await store.liveViewers.put(old, viewer("run-1", "main")), false, "the epoch moved on");
  assert.deepEqual(rawRows(file, "run-1"), [], "nothing written");
  assert.equal(await store.liveViewers.put(current, viewer("run-1", "main")), true);
  assert.deepEqual((await store.liveViewers.of("run-1")).map((row) => row.runner), ["runner-b"]);
});

test("a lapsed lease's put is refused: false, and nothing of it written, the epoch still the claim's", async (t) => {
  const { store, clock, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  clock.now += 1_001;
  assert.equal((await store.runs.get("run-1")).epoch, claim.epoch, "no one retook it");
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main")), false, "its lease ran out");
  assert.deepEqual(rawRows(file, "run-1"), [], "nothing written");
});

test("of() is empty after the lease lapses, though no purge has run: the row is still held", async (t) => {
  const { store, clock, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main")), true);
  clock.now += 1_001;
  assert.deepEqual(await store.liveViewers.of("run-1"), [], "a lapsed claim names no viewer");
  assert.equal(rawRows(file, "run-1").length, 1, "the row is still there: of() hides it, no purge took it");
});

test("of() shows only the run's runner's rows at its epoch: a row another runner wrote at that epoch is not shown", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main")), true);
  const db = new DatabaseSync(file, { timeout: 5_000 });
  try {
    db.prepare("INSERT INTO browser_viewers (run_id, tag, port, viewer_id, sealed, at, runner, epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("run-1", "planted", 1, "x", new Uint8Array([1]), 0, "runner-z", claim.epoch);
  } finally {
    db.close();
  }
  assert.deepEqual((await store.liveViewers.of("run-1")).map((row) => row.tag), ["main"], "runner-z's row, at the run's epoch, is not the run's runner's");
});

test("a drop is fenced by the epoch alone: its tag, or every row of the run; a stale epoch's drops nothing", async (t) => {
  const { store, clock, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  await store.liveViewers.put(claim, viewer("run-1", "main"));
  await store.liveViewers.put(claim, viewer("run-1", "second"));
  await store.liveViewers.drop(claim, "second");
  assert.deepEqual(rawRows(file, "run-1").map((row) => row.tag), ["main"], "one tag");
  clock.now += 1_001;
  await store.liveViewers.drop(claim);
  assert.deepEqual(rawRows(file, "run-1"), [], "all of the run's, under its epoch though its lease ran out");
  const current = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  await store.liveViewers.put(current, viewer("run-1", "main"));
  await store.liveViewers.drop(claim);
  assert.equal(rawRows(file, "run-1").length, 1, "a stale epoch drops nothing");
});

test("the run's end purges its rows, in its end commit", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.liveViewers.put(claim, viewer("run-1", "main"));
  await store.runs.update(claim, { state: "ended" });
  assert.deepEqual(rawRows(file, "run-1"), [], "gone with the end");
});

test("a reclaim purges the older epoch's rows, in the claim's own transaction", async (t) => {
  const { store, clock, file } = await storeOn(t);
  await queued(store, "run-1");
  const first = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  await store.liveViewers.put(first, viewer("run-1", "main"));
  clock.now += 1_001;
  const second = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  assert.ok(second && second.epoch > first.epoch, "taken again at a newer epoch");
  assert.deepEqual(rawRows(file, "run-1"), [], "the lapsed claim's rows went with the take");
});

test("the sealed bytes open only at their own column: the run and the tag they were put for", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.liveViewers.put(claim, viewer("run-1", "main"));
  const [row] = await store.liveViewers.of("run-1");
  assert.equal(unsealColumn(KEY, sealedAt.liveViewer("run-1", "main"), row.sealed).toString("utf8"), TOKEN, "opens at its own run and tag");
  assert.throws(() => unsealColumn(KEY, sealedAt.liveViewer("run-1", "other"), row.sealed), "another tag's column does not open it");
  assert.throws(() => unsealColumn(KEY, sealedAt.liveViewer("run-2", "main"), row.sealed), "another run's column does not open it");
  assert.equal(JSON.stringify(sealedAt.liveViewer("run-1", "main")), JSON.stringify({ table: "browser_viewers", row: "run-1/main", column: "sealed" }));
});

test("nothing of the row is in the run's view: no token, no viewer id, no sealed bytes", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const put = viewer("run-1", "main", { id: "viewer-id-unique-77" });
  await store.liveViewers.put(claim, put);
  const view = JSON.stringify(await readRun(store, "run-1", BACKGROUND_CONTEXT));
  for (const said of [TOKEN, "viewer-id-unique-77", Buffer.from(put.sealed).toString("base64"), "browser_viewers"]) assert.equal(view.includes(said), false, `the run's view never holds ${said.slice(0, 20)}…`);
});

test("the rows go with the run", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.liveViewers.put(claim, viewer("run-1", "main"));
  const db = new DatabaseSync(file, { timeout: 5_000 });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("DELETE FROM browser_viewers WHERE run_id = 'none'").run();
    const fk = db.prepare("SELECT \"table\" FROM pragma_foreign_key_list('browser_viewers')").all();
    const onDelete = db.prepare("SELECT on_delete FROM pragma_foreign_key_list('browser_viewers')").all();
    assert.deepEqual([fk.map((row) => row.table), onDelete.map((row) => row.on_delete)], [["runs"], ["CASCADE"]], "browser_viewers.run_id references runs, on delete cascade");
  } finally {
    db.close();
  }
});
