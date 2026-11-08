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
  storage.stage({ take: [{ command: 7, effect }] });
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
  storage.stage({ run: { state: "ended" }, also: [postOf("run-twice")], take: [{ command: 8, effect }, { command: 9, effect }] });
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
  const effect = await storage.mintId();
  storage.stage({ take: [{ command: 10, effect }] });
  await assert.rejects(
    commitWrites(storage, [{ type: "entry", value: { id: effect, conversationId: ROOT, kind: "message" } }], context),
    (error) => error instanceof CommandTaken && error.runId === "run-mine" && error.commandId === 10,
  );
  assert.equal(await takenAt(db, 10), null, "the other run's command untaken");
});

test("a take lands only in the commit that stores its effect: a commit without the effect, a refused one and a failed one leave the command untaken; the effect's commit takes it in its own transaction", async (t) => {
  const db = await scratchConnection(t);
  const claim = await runRow(db, "run-keyed", 1);
  // A crash, once armed, after the commit's writes and before its end (at the take's own update).
  const crash = { on: false };
  const check = (sql) => {
    if (crash.on && /^UPDATE commands SET taken_at/.test(sql)) throw new Error("injected crash at the take");
  };
  const wrap = (tx) => ({
    exec: async (sql) => (check(sql), tx.exec(sql)),
    run: async (sql, ...params) => (check(sql), tx.run(sql, ...params)),
    runCounted: async (sql, ...params) => (check(sql), tx.runCounted(sql, ...params)),
    get: async (sql, ...params) => (check(sql), tx.get(sql, ...params)),
    all: async (sql, ...params) => (check(sql), tx.all(sql, ...params)),
    step: async (statement) => (check(statement.sql), tx.step(statement)),
  });
  const connection = { get: (...args) => db.connection.get(...args), all: (...args) => db.connection.all(...args), transaction: (work, options) => db.connection.transaction((tx) => work(wrap(tx)), options) };
  const storage = await RunStorage.open(connection, claim, () => NOW);
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  await commandRow(db, 12, "run-keyed");
  const effect = await storage.mintId();
  storage.stage({ take: [{ command: 12, effect }] });
  // 1. A commit that stores something else: the take waits for its effect.
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message", mark: "other" } }], context);
  assert.equal(await takenAt(db, 12), null, "not taken by a commit without its effect");
  // 2. The effect's commit refused by pi's own check (the id is taken already): untaken.
  const taken = await storage.commit([[{ type: "entry", value: { id: 1, conversationId: ROOT, kind: "message", mark: "dup" } }]], () => {}, context);
  assert.equal(taken.stored, 0, "refused");
  assert.equal(await takenAt(db, 12), null, "not taken by a refused commit");
  // 3. The effect's commit fails: nothing of it, the command untaken.
  crash.on = true;
  await assert.rejects(commitWrites(storage, [{ type: "entry", value: { id: effect, conversationId: ROOT, kind: "message", mark: "effect" } }], context), /injected crash/);
  assert.equal(await db.get("SELECT 1 AS found FROM pi_entries WHERE run_id = ? AND id = ?", "run-keyed", effect), undefined, "no effect");
  assert.equal(await takenAt(db, 12), null, "not taken by a failed commit");
  // 4. The effect's commit lands: the effect and the take, in one transaction.
  crash.on = false;
  await commitWrites(storage, [{ type: "entry", value: { id: effect, conversationId: ROOT, kind: "message", mark: "effect" } }], context);
  assert.ok(await db.get("SELECT 1 AS found FROM pi_entries WHERE run_id = ? AND id = ?", "run-keyed", effect), "the effect");
  assert.equal(await takenAt(db, 12), NOW, "and the take with it");
});

test("a take keyed to its marker is not taken by another path's change of the same document or update of the same task (the command's own write never landed)", async (t) => {
  const { db, storage } = await setUp(t, "run-docs");
  await commandRow(db, 14, "run-docs");
  const doc = await storage.mintId();
  const tk = await storage.mintId();
  const task = (status) => ({ type: "task", value: { id: tk, conversationId: ROOT, kind: "test.task", version: 1, input: {}, state: { status }, background: false, abortRequested: false } });
  await commitWrites(storage, [{ type: "document.create", record: { id: doc, kind: "test.notes", scope: { kind: "conversation", conversationId: ROOT }, history: "rewindable", fork: "asOf" }, content: { kind: "base", version: 1, value: { n: 1 } } }, task("pending")], context);
  const marker = await storage.mintId();
  storage.stage({ take: [{ command: 14, effect: marker }] });
  // Another path (another loop, a progress write) changes the same document and task; the command's own batch never lands.
  await commitWrites(storage, [{ type: "document.change", id: doc, content: { kind: "base", version: 1, value: { n: 2, by: "another path" } } }], context);
  assert.equal(await takenAt(db, 14), null, "not taken by a change of the document its command would change");
  await commitWrites(storage, [task("running")], context);
  assert.equal(await takenAt(db, 14), null, "nor by an update of the task its command would update");
  await commitWrites(storage, [{ type: "document.retire", id: doc }], context);
  assert.equal(await takenAt(db, 14), null, "nor by a retire of that document");
});

test("a take keyed to an id the journal did not mint, or already wrote, is refused at stage, not left waiting for good", async (t) => {
  const { db, storage } = await setUp(t, "run-task");
  await commandRow(db, 16, "run-task");
  const doc = await storage.mintId();
  const tk = await storage.mintId();
  await commitWrites(storage, [
    { type: "document.create", record: { id: doc, kind: "test.notes", scope: { kind: "conversation", conversationId: ROOT }, history: "rewindable", fork: "asOf" }, content: { kind: "base", version: 1, value: { n: 1 } } },
    { type: "task", value: { id: tk, conversationId: ROOT, kind: "test.task", version: 1, input: {}, state: { status: "pending" }, background: false, abortRequested: false } },
  ], context);
  const refused = (effect, what) => assert.throws(() => storage.stage({ take: [{ command: 16, effect }] }), /no id this journal minted and has not yet written/, `${what}: refused at stage`);
  refused(doc, "an existing document");
  refused(tk, "an existing task");
  refused(doc + tk + 1000, "an id never minted");
  // Nothing was staged, so the next commit carries no take.
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context);
  assert.equal(await takenAt(db, 16), null, "a refused take is never written");
});

test("a command whose effect changes or retires a document, or updates a task, is taken through a marker entry minted in that batch", async (t) => {
  const { db, storage } = await setUp(t, "run-marker");
  await commandRow(db, 17, "run-marker");
  await commandRow(db, 18, "run-marker");
  const doc = await storage.mintId();
  await commitWrites(storage, [{ type: "document.create", record: { id: doc, kind: "test.notes", scope: { kind: "conversation", conversationId: ROOT }, history: "rewindable", fork: "asOf" }, content: { kind: "base", version: 1, value: { n: 1 } } }], context);
  const marker = await storage.mintId();
  storage.stage({ take: [{ command: 17, effect: marker }] });
  await commitWrites(storage, [{ type: "document.change", id: doc, content: { kind: "base", version: 1, value: { n: 2 } } }, { type: "entry", value: { id: marker, conversationId: ROOT, kind: "agentrun.command", data: { command: 17 } } }], context);
  assert.equal(await takenAt(db, 17), NOW, "taken with the change, through its marker");
  // A task the effect's batch creates is fresh too: it may key the take itself.
  const fresh = await storage.mintId();
  storage.stage({ take: [{ command: 18, effect: fresh }] });
  await commitWrites(storage, [{ type: "task", value: { id: fresh, conversationId: ROOT, kind: "test.task", version: 1, input: {}, state: { status: "pending" }, background: false, abortRequested: false } }], context);
  assert.equal(await takenAt(db, 18), NOW, "taken with the task its batch creates");
});

test("a later stage keeps the takes still waiting for their effects", async (t) => {
  const { db, storage } = await setUp(t, "run-restage");
  await commandRow(db, 13, "run-restage");
  const effect = await storage.mintId();
  storage.stage({ take: [{ command: 13, effect }] });
  storage.stage({ run: { state: "running" } });
  await commitWrites(storage, [{ type: "entry", value: { id: effect, conversationId: ROOT, kind: "message" } }], context);
  assert.equal(await takenAt(db, 13), NOW, "the take staged first still lands with its effect");
});

test("two loops that apply the same command at once: exactly one commit lands, the other is refused with CommandTaken", async (t) => {
  const { db, claim, storage: first } = await setUp(t, "run-race");
  const second = await RunStorage.open(db.connection, claim);
  await commandRow(db, 11, "run-race");
  // Each loop's effect has an id of its own (the two journals share the run's namespace), so only the take decides.
  const one = await first.mintId();
  await second.mintId();
  const two = await second.mintId();
  first.stage({ take: [{ command: 11, effect: one }] });
  second.stage({ take: [{ command: 11, effect: two }] });
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
