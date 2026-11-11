// A store transaction that ran out of time names who held the store, in its stack (never its message, which an answer may
// carry): where it was opened, how late its deadline fired when this process's event loop was held, and the other
// transactions open in this process. A begin that waited out its busy timeout names the transactions open here too, so
// a log of a 409 home_busy or a 500 StoreDeadline says which caller to fix.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { sqliteAdapterTests } from "./store-target.mjs";
import { Connection } from "../dist/store/sqlite/connection.js";
import { StoreBusy, StoreDeadline } from "../dist/store/index.js";

const test = sqliteAdapterTests(nodeTest, "the SQLite connection's transactions");

async function file(t) {
  const dir = mkdtempSync(join(tmpdir(), "store-holder-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "c.sqlite");
}

/** Holds this process's event loop for `ms`, as a synchronous check of a large binary did. */
const hold = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };

test("a transaction still open at its deadline names where it was opened, and that its timer fired late while the event loop was held", async (t) => {
  const db = await Connection.open(await file(t));
  t.after(() => db.close());
  await db.exec("CREATE TABLE notes (text TEXT)");
  const openedByThisTest = async () => db.transaction(async (tx) => {
    await tx.run("INSERT INTO notes (text) VALUES (?)", "held");
    hold(1_300);
    await tx.run("INSERT INTO notes (text) VALUES (?)", "never");
  }, { deadlineMs: 100 });
  await assert.rejects(openedByThisTest(), (error) => {
    assert.ok(error instanceof StoreDeadline, String(error));
    assert.doesNotMatch(error.message, /opened at|store-holder-named/, "the message, which an answer may carry, is as it was");
    assert.match(error.stack, /the transaction was opened at:\n[\s\S]*store-holder-named\.test\.mjs/);
    assert.match(error.stack, /its deadline's timer fired \d+ ms late: this process's event loop was held that long/);
    return true;
  });
  assert.equal((await db.get("SELECT count(*) AS n FROM notes")).n, 0, "rolled back, nothing written");
});

test("a begin that waits out its busy timeout names the transaction open in this process that holds the lock", async (t) => {
  const path = await file(t);
  const holder = await Connection.open(path);
  const waiter = await Connection.open(path, { busyTimeoutMs: 200 });
  t.after(async () => { await waiter.close(); await holder.close(); });
  await holder.exec("CREATE TABLE notes (text TEXT)");
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let began;
  const begun = new Promise((resolve) => { began = resolve; });
  const lockHolderOfThisTest = () => holder.transaction(async (tx) => {
    await tx.run("INSERT INTO notes (text) VALUES (?)", "holding");
    began();
    await released;
  });
  const holding = lockHolderOfThisTest();
  await begun;
  await assert.rejects(waiter.transaction(async (tx) => tx.run("INSERT INTO notes (text) VALUES (?)", "waits")), (error) => {
    assert.ok(error instanceof StoreBusy, String(error));
    assert.match(error.stack, /other transactions open in this process:\n {2}open \d+ ms, opened at:\n[\s\S]*lockHolderOfThisTest/);
    return true;
  });
  release();
  await holding;
});
