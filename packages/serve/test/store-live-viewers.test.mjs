// The store's live viewers (store.liveViewers): each open computer session's viewer hand-over, one row per run, computer
// kind (browser, desktop, phone) and session tag, its token sealed under the seal key at its own column
// (sealedAt.liveViewer). The runner puts and drops them under its claim; the server reads them. The contract browser-live.ts
// is written against:
// - put: the claim's fence (its epoch and its lease, on the store's clock), upsert on (run_id, kind, tag), `at` the store's
//   clock, runner and epoch the claim's; false when fenced, and nothing written;
// - drop: the claim's epoch alone, as run_live's drop; one kind's tag, a whole kind, or all of the run's rows;
// - of: newest first, only rows of the run's epoch, under a live lease, by the run's runner, each carrying its kind;
// - the rows go with the run's end (its end commit), with a take or reclaim of the run (a newer epoch), and with the run.
// The table's rows are read raw here (store-target.mjs raw: the store's file, or its Postgres schema) to tell a row not
// written from one not shown.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { StoreConstraint } from "../dist/store/store.js";
import { queued, storeOn } from "./store-helpers.mjs";
import { raw } from "./store-target.mjs";

const { sealedAt, sealColumn, unsealColumn } = await import("../dist/store/seal.js");
const { readRun } = await import("../dist/store-reads/runs.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

const KEY = randomBytes(32);
const TOKEN = `not-a-secret-${"viewer-token-0123456789"}`;
const viewer = (runId, tag, { kind = "browser", port = 47_001, id = `viewer-${kind}-${tag}` } = {}) => ({ kind, tag, port, id, sealed: sealColumn(KEY, sealedAt.liveViewer(runId, kind, tag), TOKEN) });

/** The table's rows for `runId`, raw: what the store holds, whatever of() shows. */
async function rawRows(file, runId) {
  const db = await raw(file, { readOnly: true });
  try {
    return await db.all("SELECT kind, tag, port, viewer_id, at, runner, epoch FROM computer_viewers WHERE run_id = ? ORDER BY kind, tag", runId);
  } finally {
    await db.close();
  }
}

test("a put under the claim is the row of(): upserted on its kind and tag, at the store's clock, newest first, its runner the claim's", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main")), true);
  clock.now += 10;
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "second", { port: 47_002 })), true);
  clock.now += 10;
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main", { port: 47_003, id: "viewer-main-2" })), true, "the same kind and tag again: upserted");
  const rows = await store.liveViewers.of("run-1");
  assert.deepEqual(rows.map(({ kind, tag, port, id, at, runner }) => ({ kind, tag, port, id, at, runner })), [
    { kind: "browser", tag: "main", port: 47_003, id: "viewer-main-2", at: clock.now, runner: "runner-a" },
    { kind: "browser", tag: "second", port: 47_002, id: "viewer-browser-second", at: clock.now - 10, runner: "runner-a" },
  ], "newest first; the upsert moved its row's at");
  assert.ok(rows.every((row) => row.sealed instanceof Uint8Array && !("epoch" in row)), "its sealed bytes, and no epoch in the row");
});

test("a desktop and a browser viewer with the same tag on one run coexist: of() returns both, each with its kind", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main", { kind: "browser", port: 47_001 })), true);
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main", { kind: "desktop", port: 47_002 })), true, "same tag, another kind: its own row");
  const rows = (await store.liveViewers.of("run-1")).map((row) => ({ kind: row.kind, tag: row.tag, port: row.port }));
  assert.deepEqual(rows.sort((a, b) => a.kind.localeCompare(b.kind)), [
    { kind: "browser", tag: "main", port: 47_001 },
    { kind: "desktop", tag: "main", port: 47_002 },
  ], "two rows, one per kind, the tag shared");
});

test("the seal AAD binds the kind: a row sealed as browser does not open as desktop, nor the reverse", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.liveViewers.put(claim, viewer("run-1", "main", { kind: "browser" }));
  await store.liveViewers.put(claim, viewer("run-1", "main", { kind: "desktop" }));
  const rows = await store.liveViewers.of("run-1");
  const browser = rows.find((row) => row.kind === "browser");
  const desktop = rows.find((row) => row.kind === "desktop");
  assert.equal(unsealColumn(KEY, sealedAt.liveViewer("run-1", "browser", "main"), browser.sealed).toString("utf8"), TOKEN, "the browser row opens at its own kind");
  assert.throws(() => unsealColumn(KEY, sealedAt.liveViewer("run-1", "desktop", "main"), browser.sealed), "the browser row does not open as desktop");
  assert.equal(unsealColumn(KEY, sealedAt.liveViewer("run-1", "desktop", "main"), desktop.sealed).toString("utf8"), TOKEN, "the desktop row opens at its own kind");
  assert.throws(() => unsealColumn(KEY, sealedAt.liveViewer("run-1", "browser", "main"), desktop.sealed), "the desktop row does not open as browser");
});

test("the kind CHECK refuses an unknown kind: the store rejects it, and nothing is written", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await assert.rejects(store.liveViewers.put(claim, viewer("run-1", "main", { kind: "tablet" })), StoreConstraint, "an unknown kind is refused");
  assert.deepEqual(await rawRows(file, "run-1"), [],"nothing written");
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main", { kind: "phone" })), true, "a known kind writes");
});

test("a drop by kind leaves the other kind; a drop with no kind clears all; a stale epoch drops nothing", async (t) => {
  const { store, clock, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  await store.liveViewers.put(claim, viewer("run-1", "main", { kind: "browser" }));
  await store.liveViewers.put(claim, viewer("run-1", "main", { kind: "desktop" }));
  await store.liveViewers.put(claim, viewer("run-1", "second", { kind: "desktop" }));
  await store.liveViewers.drop(claim, "desktop", "second");
  assert.deepEqual((await rawRows(file, "run-1")).map((row) => `${row.kind}/${row.tag}`), ["browser/main", "desktop/main"], "one kind's one tag");
  await store.liveViewers.drop(claim, "desktop");
  assert.deepEqual((await rawRows(file, "run-1")).map((row) => `${row.kind}/${row.tag}`), ["browser/main"], "the kind's rows go, the browser row left");
  clock.now += 1_001;
  await store.liveViewers.drop(claim);
  assert.deepEqual(await rawRows(file, "run-1"), [],"all of the run's, under its epoch though its lease ran out");
  const current = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  await store.liveViewers.put(current, viewer("run-1", "main"));
  await store.liveViewers.drop(claim);
  assert.equal((await rawRows(file, "run-1")).length, 1, "a stale epoch drops nothing");
});

test("a stale epoch's put is refused: false, and nothing of it written", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const old = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.release(old);
  const current = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  assert.equal(await store.liveViewers.put(old, viewer("run-1", "main")), false, "the epoch moved on");
  assert.deepEqual(await rawRows(file, "run-1"), [],"nothing written");
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
  assert.deepEqual(await rawRows(file, "run-1"), [],"nothing written");
});

test("of() is empty after the lease lapses, though no purge has run: the row is still held", async (t) => {
  const { store, clock, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main")), true);
  clock.now += 1_001;
  assert.deepEqual(await store.liveViewers.of("run-1"), [], "a lapsed claim names no viewer");
  assert.equal((await rawRows(file, "run-1")).length, 1, "the row is still there: of() hides it, no purge took it");
});

test("of() shows only the run's runner's rows at its epoch: a row another runner wrote at that epoch is not shown", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  assert.equal(await store.liveViewers.put(claim, viewer("run-1", "main")), true);
  const db = await raw(file);
  try {
    await db.run("INSERT INTO computer_viewers (run_id, kind, tag, port, viewer_id, sealed, at, runner, epoch) VALUES (?, 'browser', ?, ?, ?, ?, ?, ?, ?)", "run-1", "planted", 1, "x", new Uint8Array([1]), 0, "runner-z", claim.epoch);
  } finally {
    await db.close();
  }
  assert.deepEqual((await store.liveViewers.of("run-1")).map((row) => row.tag), ["main"], "runner-z's row, at the run's epoch, is not the run's runner's");
});

test("the run's end purges every kind's rows, in its end commit", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.liveViewers.put(claim, viewer("run-1", "main", { kind: "browser" }));
  await store.liveViewers.put(claim, viewer("run-1", "main", { kind: "desktop" }));
  await store.runs.update(claim, { state: "ended" });
  assert.deepEqual(await rawRows(file, "run-1"), [],"gone with the end, every kind");
});

test("a reclaim purges every kind's rows of the older epoch, in the claim's own transaction", async (t) => {
  const { store, clock, file } = await storeOn(t);
  await queued(store, "run-1");
  const first = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  await store.liveViewers.put(first, viewer("run-1", "main", { kind: "browser" }));
  await store.liveViewers.put(first, viewer("run-1", "main", { kind: "phone" }));
  clock.now += 1_001;
  const second = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  assert.ok(second && second.epoch > first.epoch, "taken again at a newer epoch");
  assert.deepEqual(await rawRows(file, "run-1"), [],"the lapsed claim's rows went with the take, every kind");
});

test("the sealed bytes open only at their own column: the run, the kind and the tag they were put for", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.liveViewers.put(claim, viewer("run-1", "main"));
  const [row] = await store.liveViewers.of("run-1");
  assert.equal(unsealColumn(KEY, sealedAt.liveViewer("run-1", "browser", "main"), row.sealed).toString("utf8"), TOKEN, "opens at its own run, kind and tag");
  assert.throws(() => unsealColumn(KEY, sealedAt.liveViewer("run-1", "browser", "other"), row.sealed), "another tag's column does not open it");
  assert.throws(() => unsealColumn(KEY, sealedAt.liveViewer("run-1", "desktop", "main"), row.sealed), "another kind's column does not open it");
  assert.throws(() => unsealColumn(KEY, sealedAt.liveViewer("run-2", "browser", "main"), row.sealed), "another run's column does not open it");
  assert.equal(JSON.stringify(sealedAt.liveViewer("run-1", "browser", "main")), JSON.stringify({ table: "computer_viewers", row: "run-1/browser:main", column: "sealed" }));
});

test("nothing of the row is in the run's view: no token, no viewer id, no sealed bytes", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const put = viewer("run-1", "main", { id: "viewer-id-unique-77" });
  await store.liveViewers.put(claim, put);
  const view = JSON.stringify(await readRun(store, "run-1", BACKGROUND_CONTEXT));
  for (const said of [TOKEN, "viewer-id-unique-77", Buffer.from(put.sealed).toString("base64"), "computer_viewers"]) assert.equal(view.includes(said), false, `the run's view never holds ${said.slice(0, 20)}…`);
});

test("the rows go with the run", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.liveViewers.put(claim, viewer("run-1", "main"));
  const db = await raw(file);
  try {
    // The schema's own record of the foreign key: SQLite's pragma, Postgres's catalog.
    const fk = db.kind === "sqlite"
      ? (await db.all("SELECT \"table\", on_delete FROM pragma_foreign_key_list('computer_viewers')")).map((row) => [row.table, row.on_delete])
      : (await db.all("SELECT confrelid::regclass::text AS \"table\", confdeltype FROM pg_constraint WHERE conrelid = 'computer_viewers'::regclass AND contype = 'f'")).map((row) => [row.table, row.confdeltype === "c" ? "CASCADE" : row.confdeltype]);
    assert.deepEqual(fk, [["runs", "CASCADE"]], "computer_viewers.run_id references runs, on delete cascade");
  } finally {
    await db.close();
  }
});
