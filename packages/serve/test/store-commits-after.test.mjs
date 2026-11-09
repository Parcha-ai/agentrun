// A run's journal read commit by commit, for the live view (journal.commitsAfter): for each stored commit after a seq, in
// order, its own entries, the documents it changed (each's value at that seq; a retired one marked, with no value), and
// the tasks and submissions it wrote, as it wrote them (pi_commit_writes: one row per task, submission and latest-only
// document a commit writes, in that commit's own transaction), all in one read: a replay equals the live view. Two
// batches stored by one storage call are two commits, each with only its own records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { runRow, scratchConnection } from "./store-support.mjs";

const { RunStorage } = await import("../dist/store/index.js");
const context = BACKGROUND_CONTEXT;
const ROOT = 1;

const task = (id, status, mark) => ({ type: "task", value: { id, conversationId: ROOT, kind: "test.task", version: 1, input: { mark }, state: { status, checkpoint: { mark } }, background: false, abortRequested: false } });
const notes = (id, value) => ({ type: "document.create", record: { id, kind: "test.notes", scope: { kind: "conversation", conversationId: ROOT }, history: "rewindable", fork: "asOf" }, content: { kind: "base", version: 1, value } });
const change = (id, value) => ({ type: "document.change", id, content: { kind: "base", version: 1, value } });

/** A claimed run's journal on a fresh store, its root conversation committed at seq 1. */
async function journalOf(t, runId = "run-1") {
  const db = await scratchConnection(t);
  const storage = await RunStorage.open(db.connection, await runRow(db, runId, 1));
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  return { db, storage };
}

/** Each commit as the test reads it: its seq, its entries' marks, its documents, its tasks' and submissions' marks. */
const shape = (page) => page.commits.map((commit) => ({
  seq: Number(commit.seq),
  entries: commit.entries.map((entry) => entry.mark),
  documents: commit.documents.map((doc) => ({ id: Number(doc.id), kind: doc.kind, conversationId: Number(doc.conversationId), ...(doc.retired ? { retired: true } : { value: doc.value }) })),
  tasks: commit.tasks.map((one) => one.input.mark + ":" + one.state.status),
  submissions: commit.submissions.map((one) => one.mark),
}));

test("two batches stored by one storage call come back as two commits, each with only its own records", async (t) => {
  const { storage } = await journalOf(t);
  const [a, b, tk, sub, doc] = [await storage.mintId(), await storage.mintId(), await storage.mintId(), await storage.mintId(), await storage.mintId()];
  const seqs = [];
  const result = await storage.commit([
    [{ type: "entry", value: { id: a, conversationId: ROOT, kind: "message", mark: "a" } }],
    [{ type: "entry", value: { id: b, conversationId: ROOT, kind: "message", mark: "b" } }, task(tk, "pending", "t"), { type: "submission", value: { id: sub, conversationId: ROOT, status: "queued", requestId: "r-1", mark: "s" } }, notes(doc, { n: 1 })],
  ], (_index, seq) => seqs.push(Number(seq)), context);
  assert.equal(result.stored, 2, "two batches, two commits");
  assert.deepEqual(shape(await storage.commitsAfter(1, 10, context)), [
    { seq: seqs[0], entries: ["a"], documents: [], tasks: [], submissions: [] },
    { seq: seqs[1], entries: ["b"], documents: [{ id: doc, kind: "test.notes", conversationId: ROOT, value: { n: 1 } }], tasks: ["t:pending"], submissions: ["s"] },
  ]);
});

test("a task written in two commits shows each write in its own commit, as it was then: a replay equals the live view", async (t) => {
  const { storage } = await journalOf(t);
  const tk = await storage.mintId();
  await commitWrites(storage, [task(tk, "pending", "t")], context);
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message", mark: "between" } }], context);
  await commitWrites(storage, [task(tk, "running", "t")], context);
  assert.deepEqual(shape(await storage.commitsAfter(1, 10, context)).map(({ seq, entries, tasks }) => ({ seq, entries, tasks })), [
    { seq: 2, entries: [], tasks: ["t:pending"] },
    { seq: 3, entries: ["between"], tasks: [] },
    { seq: 4, entries: [], tasks: ["t:running"] },
  ]);
});

test("a submission placed at commit 1 and settled at commit 5 shows as placed in commit 1 and as settled in commit 5", async (t) => {
  const { storage } = await journalOf(t);
  const sub = await storage.mintId();
  const submission = (status) => ({ type: "submission", value: { id: sub, conversationId: ROOT, status, requestId: "r-1", mark: status } });
  await commitWrites(storage, [submission("placed")], context);
  for (const mark of ["x", "y", "z"]) await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message", mark } }], context);
  await commitWrites(storage, [submission("done")], context);
  assert.deepEqual(shape(await storage.commitsAfter(1, 10, context)).map(({ seq, submissions }) => ({ seq, submissions })), [
    { seq: 2, submissions: ["placed"] },
    { seq: 3, submissions: [] },
    { seq: 4, submissions: [] },
    { seq: 5, submissions: [] },
    { seq: 6, submissions: ["done"] },
  ]);
});

test("a task checkpointed twice by one storage call holding two commits shows each checkpoint in its own commit", async (t) => {
  const { storage } = await journalOf(t);
  const tk = await storage.mintId();
  const checkpoint = (mark) => ({ type: "task", value: { id: tk, conversationId: ROOT, kind: "test.task", version: 1, input: { mark: "t" }, state: { status: "running", checkpoint: { mark } }, background: false, abortRequested: false } });
  const result = await storage.commit([[checkpoint("first")], [checkpoint("second")]], () => {}, context);
  assert.equal(result.stored, 2);
  const commits = (await storage.commitsAfter(1, 10, context)).commits;
  assert.deepEqual(commits.map((commit) => [Number(commit.seq), commit.tasks.map((one) => one.state.checkpoint.mark)]), [[2, ["first"]], [3, ["second"]]]);
});

test("a latest-only document's value appears in the commit that wrote it: a reconnect from seq N-1 never shows a value first written at M > N", async (t) => {
  const { storage } = await journalOf(t);
  const doc = await storage.mintId();
  const latest = (value) => ({ type: "document.create", record: { id: doc, kind: "test.live", scope: { kind: "conversation", conversationId: ROOT }, history: "latest", fork: "asOf" }, content: { kind: "base", version: 1, value } });
  await commitWrites(storage, [latest({ n: 1 })], context);
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message", mark: "between" } }], context);
  await commitWrites(storage, [change(doc, { n: 2 })], context);
  // A reconnect at seq 1 that reads only seq 2: its value then, never the one written at seq 4.
  assert.deepEqual(shape(await storage.commitsAfter(1, 1, context)).map(({ seq, documents }) => ({ seq, documents })), [{ seq: 2, documents: [{ id: doc, kind: "test.live", conversationId: ROOT, value: { n: 1 } }] }], "never the value written at seq 4");
  assert.deepEqual(shape(await storage.commitsAfter(1, 10, context)).map(({ seq, documents }) => ({ seq, documents })), [
    { seq: 2, documents: [{ id: doc, kind: "test.live", conversationId: ROOT, value: { n: 1 } }] },
    { seq: 3, documents: [] },
    { seq: 4, documents: [{ id: doc, kind: "test.live", conversationId: ROOT, value: { n: 2 } }] },
  ]);
});

test("a commit rolled back by a fence failure after its writes leaves no row in the commit log", async (t) => {
  const db = await scratchConnection(t);
  const claim = await runRow(db, "run-1", 1);
  // The run row's fenced update (the staged run patch, after the batch's writes) finds no row, as under a claim moved on.
  const fenced = { on: false };
  const miss = (sql) => fenced.on && /^UPDATE runs SET state/.test(sql);
  const wrap = (tx) => ({
    exec: (sql) => tx.exec(sql),
    run: (sql, ...params) => tx.run(sql, ...params),
    runCounted: async (sql, ...params) => (miss(sql) ? 0 : tx.runCounted(sql, ...params)),
    get: async (sql, ...params) => (miss(sql) ? undefined : tx.get(sql, ...params)),
    all: async (sql, ...params) => (miss(sql) ? [] : tx.all(sql, ...params)),
    step: (statement) => tx.step(statement),
  });
  const connection = { get: (...args) => db.connection.get(...args), all: (...args) => db.connection.all(...args), transaction: (work, options) => db.connection.transaction((tx) => work(wrap(tx)), options) };
  const storage = await RunStorage.open(connection, claim);
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const tk = await storage.mintId();
  const rows = async () => Number((await db.get("SELECT COUNT(*) AS n FROM pi_commit_writes WHERE run_id = ?", "run-1")).n);
  const before = await rows();
  storage.stage({ run: { state: "ended" }, effect: tk });
  fenced.on = true;
  await assert.rejects(commitWrites(storage, [task(tk, "pending", "t")], context), (error) => error?.name === "Fenced", "the commit is refused by the fence");
  assert.equal(await rows(), before, "no log row of the refused commit");
  assert.equal(await db.get("SELECT 1 AS found FROM pi_tasks WHERE run_id = ? AND id = ?", "run-1", tk), undefined, "nor its task");
});

test("each document's value is the one at that commit's seq, and a retired document is marked, with no value", async (t) => {
  const { storage } = await journalOf(t);
  const doc = await storage.mintId();
  await commitWrites(storage, [notes(doc, { n: 1 })], context);
  await commitWrites(storage, [change(doc, { n: 2 })], context);
  await commitWrites(storage, [{ type: "document.retire", id: doc }], context);
  assert.deepEqual(shape(await storage.commitsAfter(1, 10, context)).map(({ seq, documents }) => ({ seq, documents })), [
    { seq: 2, documents: [{ id: doc, kind: "test.notes", conversationId: ROOT, value: { n: 1 } }] },
    { seq: 3, documents: [{ id: doc, kind: "test.notes", conversationId: ROOT, value: { n: 2 } }] },
    { seq: 4, documents: [{ id: doc, kind: "test.notes", conversationId: ROOT, retired: true }] },
  ]);
});

test("a document that keeps only its latest value (pi.live, pi.inbox, pi.usage) shows in each commit that wrote it at the value it wrote: commit 4 the value written at seq 4, commit 6 the one written at seq 6, never a later one", async (t) => {
  const { storage } = await journalOf(t);
  const doc = await storage.mintId();
  const latest = (value) => ({ type: "document.create", record: { id: doc, kind: "test.live", scope: { kind: "conversation", conversationId: ROOT }, history: "latest", fork: "asOf" }, content: { kind: "base", version: 1, value } });
  const between = async (mark) => commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message", mark } }], context);
  await between("2");
  await between("3");
  await commitWrites(storage, [latest({ n: 4 })], context);
  await between("5");
  await commitWrites(storage, [change(doc, { n: 6 })], context);
  await commitWrites(storage, [change(doc, { n: 7 })], context);
  const documents = async (after, limit) => shape(await storage.commitsAfter(after, limit, context)).map(({ seq, documents: docs }) => ({ seq, documents: docs }));
  assert.deepEqual(await documents(3, 1), [{ seq: 4, documents: [{ id: doc, kind: "test.live", conversationId: ROOT, value: { n: 4 } }] }], "commit 4: the value written at seq 4, never a later one");
  assert.deepEqual(await documents(5, 1), [{ seq: 6, documents: [{ id: doc, kind: "test.live", conversationId: ROOT, value: { n: 6 } }] }], "commit 6: the value written at seq 6, never a later one");
  assert.deepEqual((await documents(3, 10)).map(({ seq, documents: docs }) => [seq, docs.map((d) => d.value.n)]), [[4, [4]], [5, []], [6, [6]], [7, [7]]]);
});

test("after a seq, at most `limit` commits, with `next` to read on from, and none past the last", async (t) => {
  const { storage } = await journalOf(t);
  for (const mark of ["x", "y", "z"]) await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message", mark } }], context);
  const first = await storage.commitsAfter(1, 2, context);
  assert.deepEqual(shape(first).map((c) => c.entries), [["x"], ["y"]]);
  assert.equal(Number(first.next), 3, "read on after the last one returned");
  const rest = await storage.commitsAfter(first.next, 2, context);
  assert.deepEqual(shape(rest).map((c) => c.entries), [["z"]]);
  assert.equal(rest.next, undefined, "nothing more");
  assert.deepEqual((await storage.commitsAfter(4, 2, context)).commits, [], "none past the last");
});

test("another run's commits never appear in this run's", async (t) => {
  const { db, storage } = await journalOf(t, "run-a");
  const other = await RunStorage.open(db.connection, await runRow(db, "run-b", 1));
  await commitWrites(other, [{ type: "conversation", value: { id: ROOT } }], context);
  await commitWrites(other, [{ type: "entry", value: { id: await other.mintId(), conversationId: ROOT, kind: "message", mark: "b's" } }], context);
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message", mark: "a's" } }], context);
  assert.deepEqual(shape(await storage.commitsAfter(0, 10, context)).map((c) => c.entries), [[], ["a's"]]);
});
