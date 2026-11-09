// An import's journal write (RunStorage.applyIn, the base's importRun) is fenced by the claim fence's inserted-here form
// (store/fence.ts): it passes only for the never-claimed row its own transaction's insert returned. Onto a run that exists
// and was claimed (its lease run out, its epoch the one given) it is Fenced, as is the form naming a row this transaction
// did not insert: an import never writes into another run's journal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Fenced } from "../dist/store/store.js";
import { runRow, scratchConnection, T0 } from "./store-support.mjs";

const { RunStorage } = await import("../dist/store/journal/storage.js");
const insertRun = (tx, id) => tx.get("INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) VALUES (?, 'agent-1', 'rev-1', 'ended', 0, ?) RETURNING rowid", id, T0);

test("an import's journal write onto a run that exists and was claimed, its lease run out, is Fenced and writes nothing", async (t) => {
  const db = await scratchConnection(t);
  await runRow(db, "run-1", 1);
  await db.run("UPDATE runs SET claimed_until = ? WHERE id = 'run-1'", T0 - 1);
  await assert.rejects(
    db.connection.transaction(async (tx) => {
      const { rowid } = await tx.get("SELECT rowid FROM runs WHERE id = 'run-1'");
      await new RunStorage(db.connection, { runId: "run-1", epoch: 1 }, () => T0).applyIn(tx, [], rowid);
    }),
    Fenced,
    "a claimed run's journal is never an import's",
  );
});

test("the inserted-here form naming a row this transaction did not insert is Fenced; the row it inserted passes", async (t) => {
  const db = await scratchConnection(t);
  await runRow(db, "run-seed", 1);
  await db.connection.transaction(async (tx) => {
    const mine = await insertRun(tx, "run-imported");
    const other = await insertRun(tx, "run-other");
    await assert.rejects(new RunStorage(db.connection, { runId: "run-imported", epoch: 0 }, () => T0).applyIn(tx, [], other.rowid), Fenced, "another insert's rowid names another row");
    assert.deepEqual(await new RunStorage(db.connection, { runId: "run-imported", epoch: 0 }, () => T0).applyIn(tx, [], mine.rowid), [], "its own insert's row passes");
  });
});
