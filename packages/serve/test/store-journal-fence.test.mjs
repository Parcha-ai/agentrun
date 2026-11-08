// Every journal commit is fenced by the run's claim: once another claim moved the run's epoch on, a commit under the old
// claim is refused with Fenced and writes nothing (no journal row, no seq, no run row change), in the one transaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { runRow, scratchConnection } from "./store-support.mjs";

const { Fenced, RunStorage, journalTables } = await import("../dist/store/journal/storage.js");
const context = BACKGROUND_CONTEXT;
const ROOT = 1;

test("a journal commit under a claim whose epoch moved on is refused with Fenced and writes nothing", async (t) => {
  const connection = scratchConnection(t);
  await connection.exec(journalTables());
  const claim = await runRow(connection, "run-fenced", 1);
  const storage = await RunStorage.open(connection, claim);
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const before = await connection.get("SELECT next_seq FROM pi_metadata WHERE run_id = ?", "run-fenced");
  // Another runner claims the run: its epoch moves on.
  await connection.run("UPDATE runs SET epoch = 2 WHERE id = ?", "run-fenced");
  const entryId = await storage.mintId();
  storage.stage({ run: { state: "ended", costUsd: 1.25 } });
  await assert.rejects(commitWrites(storage, [{ type: "entry", value: { id: entryId, conversationId: ROOT, kind: "message" } }], context), (error) => error instanceof Fenced && error.runId === "run-fenced" && error.epoch === 1, "the stale claim's commit is Fenced");
  assert.equal(await connection.get("SELECT 1 AS found FROM pi_entries WHERE run_id = ? AND id = ?", "run-fenced", entryId), undefined, "no journal row");
  assert.deepEqual(await connection.get("SELECT next_seq FROM pi_metadata WHERE run_id = ?", "run-fenced"), before, "no seq taken");
  assert.deepEqual({ ...(await connection.get("SELECT state, epoch, cost_usd FROM runs WHERE id = ?", "run-fenced")) }, { state: "running", epoch: 2, cost_usd: null }, "the run row as the new claim left it");
  // Under the run's current claim the same commit is taken.
  const current = await RunStorage.open(connection, { runId: "run-fenced", epoch: 2 });
  await commitWrites(current, [{ type: "entry", value: { id: await current.mintId(), conversationId: ROOT, kind: "message" } }], context);
  assert.equal(Number((await connection.get("SELECT COUNT(*) AS n FROM pi_entries WHERE run_id = ?", "run-fenced")).n), 1);
});
