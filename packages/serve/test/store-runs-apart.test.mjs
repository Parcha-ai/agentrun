// Two runs' journals in one store file never cross: each run's ids, seqs, conversations, entries (by id and through a
// conversation), tasks, submissions and documents are its own, though both runs use the same ids (each run's namespace
// starts at pi's root, 1, and mints from 2), and a scan of one never returns the other's rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { runRow, scratchConnection } from "./store-support.mjs";

const { RunStorage, journalTables } = await import("../dist/store/journal/storage.js");
const context = BACKGROUND_CONTEXT;
const ROOT = 1;

/** A root conversation, an entry, a task, a submission and a document in `storage`, each marked with `mark`. */
async function fill(storage, mark) {
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const entryId = await storage.mintId();
  const taskId = await storage.mintId();
  const submissionId = await storage.mintId();
  const documentId = await storage.mintId();
  await commitWrites(storage, [
    { type: "entry", value: { id: entryId, conversationId: ROOT, kind: "message", mark } },
    { type: "task", value: { id: taskId, conversationId: ROOT, kind: "test.task", version: 1, input: { mark }, state: { status: "pending", checkpoint: { mark } }, background: false, abortRequested: false } },
    { type: "submission", value: { id: submissionId, conversationId: ROOT, status: "queued", requestId: "same-request", mark } },
    { type: "document.create", record: { id: documentId, kind: "test.notes", scope: { kind: "conversation", conversationId: ROOT }, history: "rewindable", fork: "asOf" }, content: { kind: "base", version: 1, value: { mark } } },
  ], context);
  return { entryId, taskId, submissionId, documentId };
}

test("two runs' journals in one store never cross: the same ids in each, each run reading only its own rows", async (t) => {
  const connection = scratchConnection(t);
  await connection.exec(journalTables());
  const a = await RunStorage.open(connection, await runRow(connection, "run-a", 1));
  const b = await RunStorage.open(connection, await runRow(connection, "run-b", 1));
  const ids = { a: await fill(a, "a"), b: await fill(b, "b") };
  // Each run's namespace is its own: the same ids, minted in the same order.
  assert.deepEqual(ids.a, ids.b, "each run mints its own ids from the same start");
  for (const [storage, mark, own] of [[a, "a", ids.a], [b, "b", ids.b]]) {
    assert.equal((await storage.entry(own.entryId, context))?.entry.mark, mark, `${mark}: entry(id) is its own`);
    assert.equal((await storage.entry(ROOT, own.entryId, context))?.entry.mark, mark, `${mark}: entry(conversation, id) is its own`);
    assert.deepEqual((await storage.scanEntries({ conversationId: ROOT }, 10, undefined, context)).items.map((e) => e.mark), [mark], `${mark}: a scan of entries reads only its own`);
    assert.deepEqual((await storage.scanConversations({}, 10, undefined, context)).items.map((c) => c.id), [ROOT], `${mark}: one root conversation`);
    assert.equal((await storage.task(own.taskId, context))?.input.mark, mark, `${mark}: task(id) is its own`);
    assert.deepEqual((await storage.scanTasks({}, 10, undefined, context)).items.map((task) => task.input.mark), [mark], `${mark}: a scan of tasks reads only its own`);
    assert.equal((await storage.submission(own.submissionId, context))?.mark, mark, `${mark}: submission(id) is its own`);
    assert.equal((await storage.submissionByRequest(ROOT, "same-request", context))?.mark, mark, `${mark}: the same request id finds its own submission`);
    assert.deepEqual((await storage.scanSubmissions({}, 10, undefined, context)).items.map((s) => s.mark), [mark], `${mark}: a scan of submissions reads only its own`);
    assert.equal((await storage.document(own.documentId, "current", context))?.value.mark, mark, `${mark}: document(id) is its own`);
    const address = { kind: "test.notes", scope: { kind: "conversation", conversationId: ROOT } };
    assert.equal((await storage.findDocument(address, "current", context))?.id, own.documentId, `${mark}: the same address finds its own document`);
    assert.deepEqual((await storage.scanDocuments({ scope: { kind: "conversation", conversationId: ROOT }, at: "current" }, 10, undefined, context)).items.map((d) => d.id), [own.documentId], `${mark}: a scan of documents reads only its own`);
  }
  // The next id of each is its own, past its own: neither saw the other's mints.
  assert.equal(await a.mintId(), ids.a.documentId + 1);
  assert.equal(await b.mintId(), ids.b.documentId + 1);
  // A reopened journal continues its own namespace.
  const again = await RunStorage.open(connection, { runId: "run-a", epoch: 1 });
  assert.ok((await again.mintId()) > ids.a.documentId, "a reopened run mints past its stored ids");
  // And the store holds both runs' rows, side by side.
  const counts = await connection.all("SELECT run_id, COUNT(*) AS n FROM pi_entries GROUP BY run_id ORDER BY run_id");
  assert.deepEqual(counts.map((row) => [row.run_id, Number(row.n)]), [["run-a", 1], ["run-b", 1]]);
});
