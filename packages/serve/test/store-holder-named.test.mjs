// A store transaction that ran out of time names who held the store, in its stack (never its message, which an answer may
// carry): where it was opened, and the other transactions open in this process. A begin that waited out its busy timeout names the transactions open here too, so
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

/** A wait of the transaction's own, with the event loop free: it counts toward the deadline in full. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a transaction still open at its deadline names where it was opened", async (t) => {
  const db = await Connection.open(await file(t));
  t.after(() => db.close());
  await db.exec("CREATE TABLE notes (text TEXT)");
  const openedByThisTest = async () => db.transaction(async (tx) => {
    await tx.run("INSERT INTO notes (text) VALUES (?)", "held");
    await wait(400);
    await tx.run("INSERT INTO notes (text) VALUES (?)", "never");
  }, { deadlineMs: 100 });
  await assert.rejects(openedByThisTest(), (error) => {
    assert.ok(error instanceof StoreDeadline, String(error));
    assert.doesNotMatch(error.message, /opened at|store-holder-named/, "the message, which an answer may carry, is as it was");
    assert.match(error.stack, /the transaction was opened at:\n[\s\S]*store-holder-named\.test\.mjs/);
    return true;
  });
  assert.equal((await db.get("SELECT count(*) AS n FROM notes")).n, 0, "rolled back, nothing written");
});

test("a begin that waits out its busy timeout names the transaction open in this process that holds the lock", async (t) => {
  const path = await file(t);
  const holder = await Connection.open(path);
  const waiter = await Connection.open(path, { busyTimeoutMs: 200 });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  // Let go whatever the assertions say, before the closes (after-hooks run in order), so the holder's transaction never
  // waits out its own deadline.
  t.after(() => release());
  t.after(async () => { await waiter.close(); await holder.close(); });
  await holder.exec("CREATE TABLE notes (text TEXT)");
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

test("a transaction counted from its call that runs out of time still in the connection's queue names where it was opened, and the one ahead of it", async (t) => {
  const db = await Connection.open(await file(t));
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  // Let go whatever the assertions say, before the close (after-hooks run in order).
  t.after(() => release());
  t.after(() => db.close());
  await db.exec("CREATE TABLE notes (text TEXT)");
  let began;
  const begun = new Promise((resolve) => { began = resolve; });
  const aheadOfItInTheQueue = () => db.transaction(async (tx) => {
    await tx.run("INSERT INTO notes (text) VALUES (?)", "ahead");
    began();
    await released;
  });
  const ahead = aheadOfItInTheQueue();
  await begun;
  const queuedByThisTest = () => db.transaction(async (tx) => tx.run("INSERT INTO notes (text) VALUES (?)", "queued"), { fromCall: true, deadlineMs: 100 });
  await assert.rejects(queuedByThisTest(), (error) => {
    assert.ok(error instanceof StoreDeadline, String(error));
    assert.match(error.stack, /the transaction was opened at:\n[\s\S]*queuedByThisTest/);
    assert.match(error.stack, /other transactions open in this process:\n {2}open \d+ ms, opened at:\n[\s\S]*aheadOfItInTheQueue/);
    return true;
  });
  release();
  await ahead;
});
