// A command is taken exactly once: its taken_at mark lands in the same fenced commit as the journal batch that carries its
// effect (stage({ take })). A command already taken, or one of another run, refuses the whole commit with CommandTaken:
// no journal row, no run patch, no staged row and no other take is written. Two loops that apply the same command: one
// commit lands, the other is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { commandRow, postOf, runRow, scratchConnection, T0 } from "./store-support.mjs";

const { CommandTaken, RunStorage } = await import("../dist/store/index.js");
const context = BACKGROUND_CONTEXT;
const ROOT = 1;
/** The journals' clock in these tests (epoch ms). */
const NOW = T0 + 7_200_000;
const TAKEN_BEFORE = T0 + 3_660_000;

async function setUp(t, runId) {
  const db = await scratchConnection(t);
  const claim = await runRow(db, runId, 1);
  const storage = await RunStorage.open(db.connection, claim, () => NOW);
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  return { db, claim, storage };
}

const takenAt = async (db, id) => (await db.get("SELECT taken_at FROM commands WHERE id = ?", id)).taken_at;

test("a staged take marks the command taken in the commit that carries its effect, and only once", async (t) => {
  const { db, storage } = await setUp(t, "run-take");
  await commandRow(db, 7, "run-take");
  const effect = await storage.mintId();
  storage.stage({ take: [7] });
  await commitWrites(storage, [{ type: "entry", value: { id: effect, conversationId: ROOT, kind: "message" } }], context);
  assert.ok((await storage.entry(effect, context)) !== undefined, "the effect's journal row");
  assert.equal(await takenAt(db, 7), NOW, "and the command taken, in that commit, on the store's clock (epoch ms)");
  // Committed, the take is cleared: the next commit does not take the command again (it would be refused).
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context);
});

test("a take of a command already taken refuses the whole commit with CommandTaken and writes nothing", async (t) => {
  const { db, storage } = await setUp(t, "run-twice");
  await commandRow(db, 8, "run-twice");
  await commandRow(db, 9, "run-twice", TAKEN_BEFORE);
  const effect = await storage.mintId();
  storage.stage({ run: { state: "ended" }, also: [postOf("run-twice")], take: [8, 9] });
  await assert.rejects(
    commitWrites(storage, [{ type: "entry", value: { id: effect, conversationId: ROOT, kind: "message" } }], context),
    (error) => error instanceof CommandTaken && error.runId === "run-twice" && error.commandId === 9,
    "the second take of command 9 is CommandTaken",
  );
  assert.equal(await db.get("SELECT 1 AS found FROM pi_entries WHERE run_id = ? AND id = ?", "run-twice", effect), undefined, "no journal row");
  assert.equal(await takenAt(db, 8), null, "no other take");
  assert.equal(await takenAt(db, 9), TAKEN_BEFORE, "the first take stands");
  assert.equal((await db.get("SELECT state FROM runs WHERE id = ?", "run-twice")).state, "running", "no run patch");
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM channel_posts")).n), 0, "no staged row");
});

test("a take of another run's command refuses the commit with CommandTaken and leaves that command untaken", async (t) => {
  const { db, storage } = await setUp(t, "run-mine");
  await runRow(db, "run-other", 1);
  await commandRow(db, 10, "run-other");
  storage.stage({ take: [10] });
  await assert.rejects(
    commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context),
    (error) => error instanceof CommandTaken && error.runId === "run-mine" && error.commandId === 10,
  );
  assert.equal(await takenAt(db, 10), null, "the other run's command untaken");
});

test("two loops that apply the same command at once: exactly one commit lands, the other is refused with CommandTaken", async (t) => {
  const { db, claim, storage: first } = await setUp(t, "run-race");
  const second = await RunStorage.open(db.connection, claim);
  await commandRow(db, 11, "run-race");
  // Each loop's effect has an id of its own (the two journals share the run's namespace), so only the take decides.
  const one = await first.mintId();
  const two = (await second.mintId()) + 1;
  first.stage({ take: [11] });
  second.stage({ take: [11] });
  const results = await Promise.allSettled([
    commitWrites(first, [{ type: "entry", value: { id: one, conversationId: ROOT, kind: "message", loop: 1 } }], context),
    commitWrites(second, [{ type: "entry", value: { id: two, conversationId: ROOT, kind: "message", loop: 2 } }], context),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"], "one commit lands, one is refused");
  const refused = results.find((result) => result.status === "rejected");
  assert.ok(refused.reason instanceof CommandTaken && refused.reason.commandId === 11, `refused with CommandTaken: ${refused.reason}`);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM pi_entries WHERE run_id = ? AND id IN (?, ?)", "run-race", one, two)).n), 1, "one effect in the journal");
  assert.notEqual(await takenAt(db, 11), null, "the command taken once");
});
