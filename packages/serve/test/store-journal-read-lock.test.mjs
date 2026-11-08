// A journal's document read is a read: one snapshot in a deferred read transaction, never the writer's lock. While another
// connection (another process: the server, another runner) holds the store's writer, the read completes without waiting.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
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
  // Another process holds the writer (BEGIN IMMEDIATE) and keeps it.
  const other = new DatabaseSync(file);
  other.exec("BEGIN IMMEDIATE");
  t.after(() => {
    try {
      other.exec("ROLLBACK");
    } catch {}
    other.close();
  });
  const started = Date.now();
  const read = await Promise.race([
    journal.document(doc, "current", context).then((stored) => ({ value: stored?.value })),
    new Promise((resolve) => setTimeout(() => resolve("waited"), 2_000)),
  ]);
  assert.deepEqual(read, { value: { n: 1 } }, `the read completes without the writer's lock (it took ${Date.now() - started} ms)`);
});
