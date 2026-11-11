// The store's one connection per process holds every other call while an interactive transaction is open, so a
// transaction's work awaits only its own statements, and one still open at its deadline is rolled back with StoreDeadline.
// A slow transaction never lets another run's journal commit interleave: the commit queued behind it lands after it ends,
// on its own, and nothing of the slow one is kept.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test as nodeTest } from "node:test";
import { sqliteAdapterTests } from "./store-target.mjs";

// Postgres runs calls side by side, so none queues behind a transaction; its deadline is store-postgres.test.mjs's.
const test = sqliteAdapterTests(nodeTest, "the one connection's queue behind a transaction");
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { runRow, scratchConnection } from "./store-support.mjs";

const { RunStorage, StoreDeadline } = await import("../dist/store/index.js");
const context = BACKGROUND_CONTEXT;
const ROOT = 1;

test("a transaction still open at its deadline is rolled back with StoreDeadline, and another run's commit behind it lands after it, never inside it", { timeout: 30_000 }, async (t) => {
  const db = await scratchConnection(t);
  const other = await RunStorage.open(db.connection, await runRow(db, "run-other", 1));
  const order = [];
  // A slow transaction: one statement, then a wait that is no statement of its own (as a model or tool call would be).
  const slow = db.connection.transaction(async (tx) => {
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('slow', '1', 1)" });
    await sleep(1_500);
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('slow-late', '1', 1)" });
  }, { deadlineMs: 300 });
  const slowDone = slow.then(() => order.push("slow committed"), (error) => (order.push("slow refused"), error));
  // Another run's journal commit, asked for while the slow one is open.
  await sleep(50);
  const commit = commitWrites(other, [{ type: "conversation", value: { id: ROOT } }], context).then(() => order.push("other committed"));
  const error = await slowDone;
  assert.ok(error instanceof StoreDeadline, `the slow transaction is refused with StoreDeadline: ${error}`);
  await commit;
  assert.deepEqual(order, ["slow refused", "other committed"], "the other run's commit lands after the slow transaction ends");
  assert.equal(await db.get("SELECT 1 AS found FROM settings WHERE key = 'slow'"), undefined, "nothing of the slow transaction is kept");
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM pi_conversations WHERE run_id = ?", "run-other")).n), 1, "the other run's commit is kept on its own");
  // The slow work's late step, past its deadline, is refused and writes nothing.
  await sleep(1_600);
  assert.equal(await db.get("SELECT 1 AS found FROM settings WHERE key = 'slow-late'"), undefined, "the late step wrote nothing");
});

test("a transaction that ends before its deadline commits, and the calls queued behind it wait for it", { timeout: 30_000 }, async (t) => {
  const db = await scratchConnection(t);
  const order = [];
  const first = db.connection.transaction(async (tx) => {
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('first', '1', 1)" });
    await sleep(200);
    order.push("first work done");
  }, { deadlineMs: 5_000 });
  await sleep(20);
  const read = db.connection.get("SELECT COUNT(*) AS n FROM settings").then((row) => (order.push("read"), Number(row.n)));
  await first;
  assert.equal(await read, 1, "the read behind the transaction sees its commit");
  assert.deepEqual(order, ["first work done", "read"]);
});

test("a transaction open while other work holds the process's event loop past its deadline commits: only time the process could run counts", { timeout: 30_000 }, async (t) => {
  const db = await scratchConnection(t);
  const held = db.connection.transaction(async (tx) => {
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('held', '1', 1)" });
    // Other work of the process (a binary hashed or a command run synchronously) holds its event loop while this
    // transaction's next statement is answered: the deadline's timer fires late, after that answer.
    setImmediate(() => {
      const until = Date.now() + 900;
      while (Date.now() < until);
    });
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('held-2', '1', 1)" });
  }, { deadlineMs: 300 });
  await held;
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM settings WHERE key IN ('held', 'held-2')")).n), 2, "both statements are kept");
});

/** Holds this process's event loop for `ms`, as other synchronous work of the process does. */
const holdLoop = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until);
};

test("a hold of the process that begins before the deadline and ends just past it is given back whole: the transaction's own work after it still fits", { timeout: 30_000 }, async (t) => {
  const db = await scratchConnection(t);
  const done = db.connection.transaction(async (tx) => {
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('before-hold', '1', 1)" });
    // Held from just after its first statement until 30 ms past its deadline: none of that time is the transaction's.
    await new Promise((resolve) => setImmediate(() => (holdLoop(1_030), resolve())));
    // Then 300 ms of its own, well within the 1 s it may run.
    await sleep(300);
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('after-hold', '1', 1)" });
    return "committed";
  }, { deadlineMs: 1_000 });
  assert.equal(await done.catch((error) => `refused: ${error}`), "committed");
  assert.deepEqual((await db.all("SELECT key FROM settings WHERE key IN ('before-hold', 'after-hold') ORDER BY key")).map((row) => row.key), ["after-hold", "before-hold"]);
});

test("a hold of the process gives back only itself: a transaction that then waits on something slow of its own is refused at its deadline", { timeout: 30_000 }, async (t) => {
  const db = await scratchConnection(t);
  const started = Date.now();
  const refused = await db.connection.transaction(async (tx) => {
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('slow-after-hold', '1', 1)" });
    await new Promise((resolve) => setImmediate(() => (holdLoop(900), resolve())));
    await sleep(3_000);
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('never', '1', 1)" });
  }, { deadlineMs: 300 }).then(() => undefined, (error) => error);
  assert.ok(refused instanceof StoreDeadline, `refused with StoreDeadline: ${refused}`);
  assert.ok(Date.now() - started < 2_500, `refused at its deadline plus the hold, never after its slow wait: ${Date.now() - started} ms`);
  assert.equal(await db.get("SELECT 1 AS found FROM settings WHERE key = 'slow-after-hold'"), undefined, "nothing of it is kept");
});

test("the host's clock set forward while a transaction is open is no hold: one that waits on something slow of its own is still refused at its deadline", { timeout: 30_000 }, async (t) => {
  const db = await scratchConnection(t);
  const realNow = Date.now;
  t.after(() => void (Date.now = realNow));
  const started = performance.now();
  const refused = await db.connection.transaction(async (tx) => {
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('clock-set', '1', 1)" });
    // An hour forward, as a clock correction sets it.
    Date.now = () => realNow() + 3_600_000;
    await sleep(3_000);
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('never', '1', 1)" });
  }, { deadlineMs: 300 }).then(() => undefined, (error) => error);
  Date.now = realNow;
  assert.ok(refused instanceof StoreDeadline, `refused with StoreDeadline: ${refused}`);
  assert.ok(performance.now() - started < 2_500, `refused at its deadline, never an hour later: ${Math.round(performance.now() - started)} ms`);
});

test("a transaction counted from its call keeps the wall clock's deadline, hold or not: a refresh lease is reckoned from it", { timeout: 30_000 }, async (t) => {
  const db = await scratchConnection(t);
  const refused = await db.connection.transaction(async (tx) => {
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('from-call', '1', 1)" });
    await new Promise((resolve) => setImmediate(() => (holdLoop(900), resolve())));
    await tx.step({ sql: "INSERT INTO settings (key, value, updated_at) VALUES ('from-call-after', '1', 1)" });
  }, { deadlineMs: 300, fromCall: true }).then(() => undefined, (error) => error);
  assert.ok(refused instanceof StoreDeadline, `refused with StoreDeadline: ${refused}`);
  assert.equal(await db.get("SELECT 1 AS found FROM settings WHERE key = 'from-call'"), undefined, "nothing of it is kept");
});
