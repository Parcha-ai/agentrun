// A journal's document read is a read: one snapshot in a deferred read transaction, never the writer's lock. While another
// connection (another process: the server, another runner) holds the store's writer, the read completes without waiting.
import assert from "node:assert/strict";
import { test } from "node:test";
import { raw } from "./store-target.mjs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { queued, storeOn } from "./store-helpers.mjs";

const context = BACKGROUND_CONTEXT;

test("a document read while another connection holds the store's writer completes without waiting for it", { timeout: 30_000 }, async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const journal = store.journal(await store.claim("run-1", "runner-a", { leaseMs: 30_000 }));
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], context);
  const doc = await journal.mintId();
  await commitWrites(journal, [{ type: "document.create", record: { id: doc, kind: "test.notes", scope: { kind: "conversation", conversationId: 1 }, history: "rewindable", fork: "asOf" }, content: { kind: "base", version: 1, value: { n: 1 } } }], context);
  // Another process holds the writer and keeps it: SQLite's writer lock (BEGIN IMMEDIATE); on Postgres every writer's lock
  // on the journal's tables (EXCLUSIVE mode: no write beside it, reads go on).
  const other = await raw(file);
  if (other.kind === "sqlite") await other.exec("BEGIN IMMEDIATE");
  else await other.exec("BEGIN; LOCK TABLE runs, pi_documents, pi_document_revisions, pi_metadata IN EXCLUSIVE MODE");
  t.after(async () => {
    await other.exec("ROLLBACK").catch(() => undefined);
    await other.close();
  });
  const started = Date.now();
  const read = await Promise.race([
    journal.document(doc, "current", context).then((stored) => ({ value: stored?.value })),
    new Promise((resolve) => setTimeout(() => resolve("waited"), 2_000)),
  ]);
  assert.deepEqual(read, { value: { n: 1 } }, `the read completes without the writer's lock (it took ${Date.now() - started} ms)`);
});
