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

/** This process held up for `ms` (a synchronous call, a long collection, the machine holding the process): its event loop
 *  runs nothing meanwhile, the store's workers run on. */
const heldUp = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** The waiter's busy wait, and the hold-up past it, in the cases below. What is left of the wait after the hold-up (the
 *  hold-up's first look, TICK_MS, is never given back) carries the holder's round trips to its commit on a loaded
 *  machine, whose small delays count as time this process ran: at 100 ms it ran out under load. */
const WAITER_BUSY_MS = 1_000;
const HELD_UP_MS = 2_500;

// The server and its runner in one process, two connections on one store: a write of one waited on a transaction of the
// other while the process was held up. That holder's statements wait for the same event loop, and its deadline never
// counts the hold-up (store/deadline.ts runnableDeadline); the wait for it counts the same way.
for (const [name, write] of [
  ["a begin", (waiter) => waiter.transaction(async (tx) => tx.run("INSERT INTO notes (text) VALUES (?)", "waited"))],
  ["a write", (waiter) => waiter.write([{ sql: "INSERT INTO notes (text) VALUES (?)", params: ["waited"] }])],
  ["a statement outside a transaction", (waiter) => waiter.run("INSERT INTO notes (text) VALUES (?)", "waited")],
]) {
  test(`${name} whose busy wait ran out on a transaction of this process while the process was held up waits on for it, never StoreBusy, and lands once it commits`, async (t) => {
    const path = await file(t);
    const holder = await Connection.open(path);
    const waiter = await Connection.open(path, { busyTimeoutMs: WAITER_BUSY_MS });
    let go;
    const going = new Promise((resolve) => { go = resolve; });
    t.after(() => go());
    t.after(async () => { await waiter.close(); await holder.close(); });
    await holder.exec("CREATE TABLE notes (text TEXT)");
    let began;
    const begun = new Promise((resolve) => { began = resolve; });
    const holding = holder.transaction(async (tx) => {
      await tx.run("INSERT INTO notes (text) VALUES (?)", "held");
      began();
      await going;
      await tx.run("INSERT INTO notes (text) VALUES (?)", "after the hold-up");
    });
    await begun;
    const waited = write(waiter);
    // Its request is with its worker (every microtask run), waiting on the holder's lock.
    await new Promise((resolve) => setImmediate(resolve));
    // Held up past the waiter's busy wait: its worker's wait runs out meanwhile, the holder's next statement waits.
    heldUp(HELD_UP_MS);
    go();
    await holding;
    await waited;
    assert.deepEqual((await holder.all("SELECT text FROM notes ORDER BY rowid")).map((row) => row.text), ["held", "after the hold-up", "waited"]);
  });
}

/** Calls `then` synchronously, the moment the request has left, each time `connection` posts a request of `op` to its
 *  worker. */
function onPost(connection, op, then) {
  const worker = Connection.workerOf(connection);
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (message, ...rest) => {
    post(message, ...rest);
    if (message.request.op === op) then();
  };
}

/** Runs microtasks only, never a timer or a worker's answer (each is a task of its own), until `done()`. */
async function microtasksUntil(done, what) {
  for (let i = 0; i < 1_000 && !done(); i++) await null;
  assert.ok(done(), what);
}

/** `connection`'s answer to its next `op` request read only once `other` has read an answer of its own (the next turn
 *  after it). Two workers' answers that both came while the process was held up are read in no order Node sets. */
function answeredAfter(connection, op, other) {
  const worker = Connection.workerOf(connection);
  const post = worker.postMessage.bind(worker);
  const emit = worker.emit.bind(worker);
  let id;
  let heldBack;
  let released = false;
  worker.postMessage = (message, ...rest) => {
    if (id === undefined && message.request.op === op) id = message.id;
    post(message, ...rest);
  };
  worker.emit = (event, ...args) => {
    if (!released && event === "message" && args[0]?.id === id) {
      heldBack = args;
      return true;
    }
    return emit(event, ...args);
  };
  const otherWorker = Connection.workerOf(other);
  const otherEmit = otherWorker.emit.bind(otherWorker);
  otherWorker.emit = (event, ...args) => {
    const result = otherEmit(event, ...args);
    if (!released && event === "message") {
      released = true;
      if (heldBack) setImmediate(() => emit("message", ...heldBack));
    }
    return result;
  };
}

// The same, with the holder's begin still in flight: both requests posted in one turn, the holder's worker took the lock,
// and the process was held up before it read either answer. No transaction of this process was known open when the wait
// was sent. When it ran out, the holder's begin was answered, its answer read first, or not yet read.
for (const [name, op, write] of [
  ["a begin", "begin", (waiter) => waiter.transaction(async (tx) => tx.run("INSERT INTO notes (text) VALUES (?)", "waited"))],
  ["a write", "write", (waiter) => waiter.write([{ sql: "INSERT INTO notes (text) VALUES (?)", params: ["waited"] }])],
  ["a statement outside a transaction", "stmt", (waiter) => waiter.run("INSERT INTO notes (text) VALUES (?)", "waited")],
]) for (const [order, beginReadAfter] of [["the begin's answer read first", false], ["the begin's answer read after the wait's", true]]) {
  test(`${name} posted in the same turn as a begin of this process that took the lock, both answers unread while the process was held up past the busy wait (${order}), waits on for it, never StoreBusy`, async (t) => {
    const path = await file(t);
    const holder = await Connection.open(path);
    const waiter = await Connection.open(path, { busyTimeoutMs: WAITER_BUSY_MS });
    t.after(async () => { await waiter.close(); await holder.close(); });
    await holder.exec("CREATE TABLE notes (text TEXT)");
    if (beginReadAfter) answeredAfter(holder, "begin", waiter);
    else answeredAfter(waiter, op, holder);
    let holderPosted = false;
    onPost(holder, "begin", () => {
      holderPosted = true;
      // Its worker takes the lock meanwhile; its answer waits unread (this turn has not ended).
      heldUp(200);
    });
    const holding = holder.transaction(async (tx) => {
      await tx.run("INSERT INTO notes (text) VALUES (?)", "held");
      await tx.run("INSERT INTO notes (text) VALUES (?)", "after the hold-up");
    });
    await microtasksUntil(() => holderPosted, "the holder's begin is posted");
    let waiterPosted = false;
    onPost(waiter, op, () => { waiterPosted = true; });
    const waited = write(waiter);
    await microtasksUntil(() => waiterPosted, "the waiter's request is posted in the same turn");
    // Held up past the waiter's busy wait: its worker's wait runs out meanwhile, the holder's begin answer unread.
    heldUp(HELD_UP_MS);
    await holding;
    await waited;
    assert.deepEqual((await holder.all("SELECT text FROM notes ORDER BY rowid")).map((row) => row.text), ["held", "after the hold-up", "waited"]);
  });
}

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
