// A command is taken exactly once: its taken_at mark lands in the same fenced commit as the journal batch that carries its
// effect (stage({ take })). A command already taken, or one of another run, refuses the whole commit with CommandTaken:
// no journal row, no run patch, no staged row and no other take is written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { COMMANDS_DDL, OUTBOX_DDL, runRow, scratchConnection } from "./store-support.mjs";

const { CommandTaken, RunStorage, journalTables } = await import("../dist/store/journal/storage.js");
const context = BACKGROUND_CONTEXT;
const ROOT = 1;

async function setUp(t, runId) {
  const connection = scratchConnection(t);
  await connection.exec(journalTables() + COMMANDS_DDL + ";\n" + OUTBOX_DDL);
  const storage = await RunStorage.open(connection, await runRow(connection, runId, 1));
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  return { connection, storage };
}

const command = async (connection, id, runId, takenAt = null) =>
  connection.run("INSERT INTO commands (id, run_id, kind, body, created_at, taken_at) VALUES (?, ?, 'approve', '{}', '2026-11-08T07:00:00.000Z', ?)", id, runId, takenAt);
const takenAt = async (connection, id) => (await connection.get("SELECT taken_at FROM commands WHERE id = ?", id)).taken_at;

test("a staged take marks the command taken in the commit that carries its effect, and only once", async (t) => {
  const { connection, storage } = await setUp(t, "run-take");
  await command(connection, 7, "run-take");
  const effect = await storage.mintId();
  storage.stage({ take: [7] });
  await commitWrites(storage, [{ type: "entry", value: { id: effect, conversationId: ROOT, kind: "message" } }], context);
  assert.ok((await storage.entry(effect, context)) !== undefined, "the effect's journal row");
  assert.match(String(await takenAt(connection, 7)), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/, "and the command taken, in that commit");
  // Committed, the take is cleared: the next commit does not take the command again (it would be refused).
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context);
});

test("a take of a command already taken refuses the whole commit with CommandTaken and writes nothing", async (t) => {
  const { connection, storage } = await setUp(t, "run-twice");
  await command(connection, 8, "run-twice");
  await command(connection, 9, "run-twice", "2026-11-08T07:01:00.000Z");
  const effect = await storage.mintId();
  storage.stage({ run: { state: "ended" }, also: [{ table: "outbox", row: { run_id: "run-twice", moment: "done" } }], take: [8, 9] });
  await assert.rejects(
    commitWrites(storage, [{ type: "entry", value: { id: effect, conversationId: ROOT, kind: "message" } }], context),
    (error) => error instanceof CommandTaken && error.runId === "run-twice" && error.commandId === 9,
    "the second take of command 9 is CommandTaken",
  );
  assert.equal(await connection.get("SELECT 1 AS found FROM pi_entries WHERE run_id = ? AND id = ?", "run-twice", effect), undefined, "no journal row");
  assert.equal(await takenAt(connection, 8), null, "no other take");
  assert.equal(await takenAt(connection, 9), "2026-11-08T07:01:00.000Z", "the first take stands");
  assert.equal((await connection.get("SELECT state FROM runs WHERE id = ?", "run-twice")).state, "running", "no run patch");
  assert.equal(Number((await connection.get("SELECT COUNT(*) AS n FROM outbox")).n), 0, "no staged row");
});

test("a take of another run's command refuses the commit with CommandTaken and leaves that command untaken", async (t) => {
  const { connection, storage } = await setUp(t, "run-mine");
  await command(connection, 10, "run-other");
  storage.stage({ take: [10] });
  await assert.rejects(
    commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context),
    (error) => error instanceof CommandTaken && error.runId === "run-mine" && error.commandId === 10,
  );
  assert.equal(await takenAt(connection, 10), null, "the other run's command untaken");
});
