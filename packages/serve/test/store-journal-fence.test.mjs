// Every journal commit is fenced by the run's claim: once another claim moved the run's epoch on, a commit under the old
// claim is refused with Fenced and writes nothing (no journal row, no seq, no run row change), in the one transaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { runRow, scratchConnection } from "./store-support.mjs";

const { Fenced, RunStorage } = await import("../dist/store/index.js");
const context = BACKGROUND_CONTEXT;
const ROOT = 1;

test("only a commit writes: a journal under a stale claim mints ids and reads, and the store holds nothing new of it", async (t) => {
  const db = await scratchConnection(t);
  await runRow(db, "run-stale", 2);
  // A journal handed a claim the run has moved past: its id namespace was never made, and minting and reading make none.
  const stale = new RunStorage(db.connection, { runId: "run-stale", epoch: 1 });
  assert.equal(await stale.mintId(), 2, "ids from pi's first after the root");
  assert.equal(await stale.conversation(ROOT, context), undefined);
  assert.equal(await db.get("SELECT 1 AS found FROM pi_metadata WHERE run_id = ?", "run-stale"), undefined, "no namespace row written outside a commit");
  // Its commit is the fenced write: refused, and still nothing written.
  await assert.rejects(commitWrites(stale, [{ type: "conversation", value: { id: ROOT } }], context), Fenced);
  assert.equal(await db.get("SELECT 1 AS found FROM pi_metadata WHERE run_id = ?", "run-stale"), undefined, "nor by the refused commit");
  // Under the run's claim, the first commit makes the namespace, and a reopened journal continues it.
  const current = new RunStorage(db.connection, { runId: "run-stale", epoch: 2 });
  await commitWrites(current, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: { id: await current.mintId(), conversationId: ROOT, kind: "message" } }], context);
  assert.deepEqual({ ...(await db.get("SELECT next_id, next_seq FROM pi_metadata WHERE run_id = ?", "run-stale")) }, { next_id: "3", next_seq: 2 });
  assert.equal(await new RunStorage(db.connection, { runId: "run-stale", epoch: 2 }).mintId(), 3, "a reopened journal mints past the stored ids");
});

test("a journal commit under a claim whose epoch moved on is refused with Fenced and writes nothing", async (t) => {
  const db = await scratchConnection(t);
  const claim = await runRow(db, "run-fenced", 1);
  const storage = await RunStorage.open(db.connection, claim);
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const before = await db.get("SELECT next_seq FROM pi_metadata WHERE run_id = ?", "run-fenced");
  // Another runner claims the run: its epoch moves on.
  await db.run("UPDATE runs SET epoch = 2 WHERE id = ?", "run-fenced");
  const entryId = await storage.mintId();
  storage.stage({ run: { state: "ended", costUsd: 1.25 } });
  await assert.rejects(commitWrites(storage, [{ type: "entry", value: { id: entryId, conversationId: ROOT, kind: "message" } }], context), (error) => error instanceof Fenced && error.runId === "run-fenced" && error.epoch === 1, "the stale claim's commit is Fenced");
  assert.equal(await db.get("SELECT 1 AS found FROM pi_entries WHERE run_id = ? AND id = ?", "run-fenced", entryId), undefined, "no journal row");
  assert.deepEqual(await db.get("SELECT next_seq FROM pi_metadata WHERE run_id = ?", "run-fenced"), before, "no seq taken");
  assert.deepEqual({ ...(await db.get("SELECT state, epoch, cost_usd FROM runs WHERE id = ?", "run-fenced")) }, { state: "running", epoch: 2, cost_usd: null }, "the run row as the new claim left it");
  // Under the run's current claim the same commit is taken.
  const current = await RunStorage.open(db.connection, { runId: "run-fenced", epoch: 2 });
  await commitWrites(current, [{ type: "entry", value: { id: await current.mintId(), conversationId: ROOT, kind: "message" } }], context);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM pi_entries WHERE run_id = ?", "run-fenced")).n), 1);
});
