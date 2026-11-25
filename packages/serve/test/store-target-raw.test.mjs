// raw() (store-target.mjs) beside a store this process holds open: a test's raw SQLite write while the in-process
// server's or runner's transaction is open waits for that transaction to commit, which it does from this process's main
// thread. The write waiting on that same thread could never see it commit (run-file-cut-handed's "database is locked"
// after a 30 s wait, on the merge queue).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Connection } from "../dist/store/sqlite/connection.js";
import { raw } from "./store-target.mjs";

test("a raw SQLite write waits out this process's own open store transaction, which commits meanwhile", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "store-target-raw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  const holder = await Connection.open(file);
  t.after(() => holder.close());
  await holder.exec("CREATE TABLE t (n INTEGER)");
  let open, release;
  const opened = new Promise((resolve) => (open = resolve)), held = new Promise((resolve) => (release = resolve));
  // The holder's transaction, as a server's: it holds the write lock until its callback, on this thread, goes on.
  const committed = holder.transaction(async (tx) => {
    await tx.run("INSERT INTO t VALUES (1)");
    open();
    await held;
  });
  await opened;
  // raw() is open before the release is scheduled, so its worker's start can never outlast the hold: the write below
  // always begins while the transaction is still held.
  const db = await raw(file, { timeout: 5_000 });
  try {
    // The holder goes on at this thread's next turn of timers: its commit needs this thread free while the write waits.
    setTimeout(release, 20);
    assert.deepEqual(await db.run("INSERT INTO t VALUES (2)"), { changes: 1 }, "written once the holder committed");
  } finally {
    await db.close();
  }
  await committed;
  assert.deepEqual((await holder.all("SELECT n FROM t ORDER BY n")).map((row) => row.n), [1, 2]);
});

test("raw's SQLite rows, bytes and errors read as node:sqlite gives them", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "store-target-raw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await raw(join(dir, "store.sqlite"));
  try {
    await db.exec("CREATE TABLE t (n INTEGER PRIMARY KEY, b BLOB)");
    assert.deepEqual(await db.run("INSERT INTO t VALUES (?, ?)", 1, new Uint8Array([0, 255])), { changes: 1 });
    const row = await db.get("SELECT n, b FROM t WHERE n = ?", 1);
    assert.equal(row.n, 1);
    assert.ok(row.b instanceof Uint8Array);
    assert.deepEqual([...row.b], [0, 255]);
    assert.equal(await db.get("SELECT n FROM t WHERE n = ?", 2), undefined);
    assert.deepEqual(await db.all("SELECT n FROM t"), [{ n: 1 }]);
    await assert.rejects(db.run("INSERT INTO t VALUES (?, ?)", 1, null), (error) => error.code === "ERR_SQLITE_ERROR" && /UNIQUE/.test(error.message));
  } finally {
    await db.close();
  }
});
