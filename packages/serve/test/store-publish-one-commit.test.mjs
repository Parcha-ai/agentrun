// A run's end and its last journal commit are one commit of the store: the run row's state, cost, metrics, summary and
// end, and the rows staged with them (an outbox row for the run's moment), written in the same transaction as the
// journal batch that carries the end. A crash injected between the journal's writes and the run row's leaves none of
// it: no journal row, no outbox row, the run still running, and the staged rows kept for the next commit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { OUTBOX_DDL, runRow, scratchConnection } from "./store-support.mjs";

const { RunStorage, journalTables } = await import("../dist/store/journal/storage.js");
const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const ENDED_AT = "2026-11-08T06:00:00.000Z";

/** `connection`, whose transactions throw at the run row's update (`UPDATE runs SET state…`), once armed. */
function crashingAtRunUpdate(connection) {
  const armed = { on: false };
  const wrap = (tx) => ({
    ...tx,
    runCounted: async (sql, ...params) => {
      if (armed.on && /^UPDATE runs SET state/.test(sql)) throw new Error("injected crash between the journal's writes and the run row's");
      return tx.runCounted(sql, ...params);
    },
  });
  return { connection: { ...connection, transaction: (callback) => connection.transaction((tx) => callback(wrap(tx))) }, armed };
}

const done = (runId) => ({ table: "outbox", row: { run_id: runId, moment: "done", body: { costUsd: 0.42 } } });

test("a run's end lands in the same commit as its last journal batch: state, cost, metrics, summary and end, and its outbox row, with the entry", async (t) => {
  const connection = scratchConnection(t);
  await connection.exec(journalTables() + OUTBOX_DDL);
  const storage = await RunStorage.open(connection, await runRow(connection, "run-end", 1));
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const endId = await storage.mintId();
  storage.stage({ run: { state: "ended", costUsd: 0.42, metrics: { requests: 3 }, summary: "Answered.", endedAt: ENDED_AT }, also: [done("run-end")] });
  await commitWrites(storage, [{ type: "entry", value: { id: endId, conversationId: ROOT, kind: "message", end: true } }], context);
  assert.equal((await storage.entry(endId, context))?.entry.end, true, "the end's journal row");
  assert.deepEqual({ ...(await connection.get("SELECT state, cost_usd, metrics, summary, ended_at FROM runs WHERE id = ?", "run-end")) }, { state: "ended", cost_usd: 0.42, metrics: JSON.stringify({ requests: 3 }), summary: "Answered.", ended_at: ENDED_AT }, "and the run row's end, in that commit");
  assert.deepEqual((await connection.all("SELECT run_id, moment, body FROM outbox")).map((row) => ({ ...row })), [{ run_id: "run-end", moment: "done", body: JSON.stringify({ costUsd: 0.42 }) }], "and its outbox row");
  // Committed, the staged rows are cleared: the next commit carries none of them.
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context);
  assert.equal(Number((await connection.get("SELECT COUNT(*) AS n FROM outbox")).n), 1, "the outbox row once");
});

test("a crash between the journal's writes and the run row's leaves none of them, and the next commit carries the staged rows", async (t) => {
  const plain = scratchConnection(t);
  await plain.exec(journalTables() + OUTBOX_DDL);
  const claim = await runRow(plain, "run-crash", 1);
  const { connection, armed } = crashingAtRunUpdate(plain);
  const storage = await RunStorage.open(connection, claim);
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const endId = await storage.mintId();
  storage.stage({ run: { state: "ended", costUsd: 0.42, endedAt: ENDED_AT }, also: [done("run-crash")] });
  armed.on = true;
  await assert.rejects(commitWrites(storage, [{ type: "entry", value: { id: endId, conversationId: ROOT, kind: "message", end: true } }], context), /injected crash/);
  assert.equal(await plain.get("SELECT 1 AS found FROM pi_entries WHERE run_id = ? AND id = ?", "run-crash", endId), undefined, "no journal row of the end");
  assert.deepEqual({ ...(await plain.get("SELECT state, cost_usd, ended_at FROM runs WHERE id = ?", "run-crash")) }, { state: "running", cost_usd: null, ended_at: null }, "the run row untouched");
  assert.equal(Number((await plain.get("SELECT COUNT(*) AS n FROM outbox")).n), 0, "no outbox row");
  // The staged rows were kept: the next commit carries them, in its one transaction.
  armed.on = false;
  await commitWrites(storage, [{ type: "entry", value: { id: endId, conversationId: ROOT, kind: "message", end: true } }], context);
  assert.equal((await plain.get("SELECT state FROM runs WHERE id = ?", "run-crash")).state, "ended");
  assert.equal(Number((await plain.get("SELECT COUNT(*) AS n FROM outbox")).n), 1);
});
