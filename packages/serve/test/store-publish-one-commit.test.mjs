// A run's end and its last journal commit are one commit of the store: the run row's state, cost, metrics, summary and
// end, and the rows staged with them (an outbox row for the run's moment), written in the same transaction as the
// journal batch that carries the end. A crash injected between the journal's writes and the run row's leaves none of
// it: no journal row, no outbox row, the run still running, and the staged rows kept for the next commit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { postOf, runRow, scratchConnection, T0 } from "./store-support.mjs";

const { RunStorage } = await import("../dist/store/index.js");
const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const ENDED_AT = T0 + 60_000;

/** The store's connection `connection`, whose transactions throw at the run row's update (`UPDATE runs SET state…`), once
 *  armed: after the journal's statements of that transaction, before its commit. */
function crashingAtRunUpdate(connection) {
  const armed = { on: false };
  const check = (sql) => {
    if (armed.on && /^UPDATE runs SET state/.test(sql)) throw new Error("injected crash between the journal's writes and the run row's");
  };
  const wrap = (tx) => ({
    exec: async (sql) => (check(sql), tx.exec(sql)),
    run: async (sql, ...params) => (check(sql), tx.run(sql, ...params)),
    runCounted: async (sql, ...params) => (check(sql), tx.runCounted(sql, ...params)),
    get: async (sql, ...params) => (check(sql), tx.get(sql, ...params)),
    all: async (sql, ...params) => (check(sql), tx.all(sql, ...params)),
    step: async (statement) => (check(statement.sql), tx.step(statement)),
  });
  return {
    connection: { get: (...args) => connection.get(...args), all: (...args) => connection.all(...args), transaction: (work, options) => connection.transaction((tx) => work(wrap(tx)), options) },
    armed,
  };
}

const done = (runId) => postOf(runId);

test("a run's end lands in the same commit as its last journal batch: state, cost, metrics, summary and end, and its outbox row, with the entry", async (t) => {
  const db = await scratchConnection(t);
  const storage = await RunStorage.open(db.connection, await runRow(db, "run-end", 1));
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const endId = await storage.mintId();
  storage.stage({ run: { state: "ended", costUsd: 0.42, metrics: { requests: 3 }, summary: "Answered.", endedAt: ENDED_AT }, also: [done("run-end")] });
  await commitWrites(storage, [{ type: "entry", value: { id: endId, conversationId: ROOT, kind: "message", end: true } }], context);
  assert.equal((await storage.entry(endId, context))?.entry.end, true, "the end's journal row");
  assert.deepEqual({ ...(await db.get("SELECT state, cost_usd, metrics, summary, ended_at FROM runs WHERE id = ?", "run-end")) }, { state: "ended", cost_usd: 0.42, metrics: JSON.stringify({ requests: 3 }), summary: "Answered.", ended_at: ENDED_AT }, "and the run row's end, in that commit");
  assert.deepEqual((await db.all("SELECT run_id, moment, body FROM channel_posts")).map((row) => ({ ...row })), [{ run_id: "run-end", moment: "done", body: JSON.stringify({ costUsd: 0.42 }) }], "and its outbox row");
  // Committed, the staged rows are cleared: the next commit carries none of them.
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM channel_posts")).n), 1, "the outbox row once");
});

test("a final state staged with no end time is stamped in that commit, on the store's clock, as the store's runs.update stamps it", async (t) => {
  const db = await scratchConnection(t);
  const at = T0 + 90_000;
  const storage = await RunStorage.open(db.connection, await runRow(db, "run-stamp", 1), () => at);
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  storage.stage({ run: { state: "stopped" } });
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context);
  const row = await db.get("SELECT state, ended_at FROM runs WHERE id = ?", "run-stamp");
  assert.deepEqual([row.state, row.ended_at], ["stopped", at], "ended_at stamped, epoch ms");
});

test("a crash between the journal's writes and the run row's leaves none of them, and the next commit carries the staged rows", async (t) => {
  const db = await scratchConnection(t);
  const claim = await runRow(db, "run-crash", 1);
  const { connection, armed } = crashingAtRunUpdate(db.connection);
  const storage = await RunStorage.open(connection, claim);
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const endId = await storage.mintId();
  storage.stage({ run: { state: "ended", costUsd: 0.42, endedAt: ENDED_AT }, also: [done("run-crash")] });
  armed.on = true;
  await assert.rejects(commitWrites(storage, [{ type: "entry", value: { id: endId, conversationId: ROOT, kind: "message", end: true } }], context), /injected crash/);
  assert.equal(await db.get("SELECT 1 AS found FROM pi_entries WHERE run_id = ? AND id = ?", "run-crash", endId), undefined, "no journal row of the end");
  assert.deepEqual({ ...(await db.get("SELECT state, cost_usd, ended_at FROM runs WHERE id = ?", "run-crash")) }, { state: "running", cost_usd: null, ended_at: null }, "the run row untouched");
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM channel_posts")).n), 0, "no outbox row");
  // The staged rows were kept: the next commit carries them, in its one transaction.
  armed.on = false;
  await commitWrites(storage, [{ type: "entry", value: { id: endId, conversationId: ROOT, kind: "message", end: true } }], context);
  assert.equal((await db.get("SELECT state FROM runs WHERE id = ?", "run-crash")).state, "ended");
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM channel_posts")).n), 1);
});
