// The store's one connection per process holds every other call while an interactive transaction is open, so a
// transaction's work awaits only its own statements, and one still open at its deadline is rolled back with StoreDeadline.
// A slow transaction never lets another run's journal commit interleave: the commit queued behind it lands after it ends,
// on its own, and nothing of the slow one is kept.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
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
