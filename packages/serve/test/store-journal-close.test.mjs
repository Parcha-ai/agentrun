// A journal's close waits for the commits already asked of it: a commit started on a fresh journal (still reading its
// id namespace before it queues its transaction) resolves, and its rows are kept, though the journal and then the store
// are closed right after it was asked for. The journal's close never closes the store's shared connection.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { queued, storeOn } from "./store-helpers.mjs";

const context = BACKGROUND_CONTEXT;

test("a commit asked of a fresh journal before its close resolves, and its rows are kept, when the store closes right after", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const journal = store.journal(claim);
  // Asked for, not awaited: the fresh journal first reads its id namespace, then queues the commit's transaction.
  const committed = commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], context).then(() => "resolved", (error) => `rejected: ${error?.name}: ${error?.message}`);
  await journal.close(context);
  await store.close();
  assert.equal(await committed, "resolved", "the commit asked before the close resolves");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM pi_conversations WHERE run_id = ?").get("run-1").n), 1, "and its row is kept");
  } finally {
    db.close();
  }
});

test("a fresh journal's first commit in flight when the store closes (no journal close) resolves, and its rows are kept", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const journal = store.journal(claim);
  // Asked for, not awaited: the store closes while the fresh journal's commit is on its way.
  const committed = commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], context).then(() => "resolved", (error) => `rejected: ${error?.name}: ${error?.message}`);
  await store.close();
  assert.equal(await committed, "resolved", "the commit asked before the store's close resolves");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM pi_conversations WHERE run_id = ?").get("run-1").n), 1, "and its row is kept");
  } finally {
    db.close();
  }
});

test("a journal's close leaves the store's connection open: another run's journal commits after it", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  await queued(store, "run-2");
  const one = store.journal(await store.claim("run-1", "runner-a", { leaseMs: 30_000 }));
  const two = store.journal(await store.claim("run-2", "runner-a", { leaseMs: 30_000 }));
  await commitWrites(one, [{ type: "conversation", value: { id: 1 } }], context);
  await one.close(context);
  await assert.doesNotReject(commitWrites(two, [{ type: "conversation", value: { id: 1 } }], context));
});
