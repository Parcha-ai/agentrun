// The custody tests' row writer (custody-support.mjs written, and marked over it) seeds a row beside a live server. The
// server's store steps an open write transaction from this same thread (connection.ts transaction: BEGIN IMMEDIATE in
// its worker, each statement sent from here), so a writer that waits for the lock on this thread holds that
// transaction's next step back until its own busy wait runs out: "database is locked" (#2327). The writer waits off
// this thread, through the store's own worker-backed connection, so the open write finishes and the row lands after it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Connection } from "../dist/store/sqlite/connection.js";
import { written } from "./custody-support.mjs";

test("a row written beside a store whose write is open waits for that write, never holds it back: no database is locked", { timeout: 60_000 }, async (t) => {
  const data = mkdtempSync(join(tmpdir(), "custody-written-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const holder = await Connection.open(join(data, "store.sqlite"));
  t.after(() => holder.close());
  let begun;
  let release;
  const open = new Promise((resolve) => (begun = resolve));
  const held = new Promise((resolve) => (release = resolve));
  // A write the store keeps open across this thread's turns, as the server's are: it ends once this thread lets it.
  const holding = holder.transaction(async (tx) => {
    await tx.run("CREATE TABLE custody_probe (n INTEGER)");
    begun();
    await held;
    await tx.run("INSERT INTO custody_probe (n) VALUES (1)");
  });
  await open;
  const started = performance.now();
  const writing = written({ data }, "INSERT INTO custody_probe (n) VALUES (2)");
  release();
  await holding;
  await writing;
  assert.ok(performance.now() - started < 5_000, "the row waited for the open write alone, not a busy timeout");
  assert.deepEqual((await holder.all("SELECT n FROM custody_probe ORDER BY n")).map(({ n }) => n), [1, 2], "the open write first, then the row");
});
