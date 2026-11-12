// A run's workflow decision receipts over the one store (store-reads/decisions.ts): the same rows durableDecisions read
// from a run's own database, read now through the journal view — the single `agentrun.decisions` document's receipts, or
// the keyed `.count` and family rows in order. graph-view's ended-run path reads a stored workflow run's decisions this way.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { decisionKey } from "../dist/workflow/decisions.js";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { decisionsOverStore } = await import("../dist/store-reads/decisions.js");

const context = BACKGROUND_CONTEXT;
const sessionDoc = (id, kind, key, value) => ({ type: "document.create", record: { id, kind, scope: { kind: "session" }, history: "latest", fork: "asOf", ...(key !== undefined ? { key } : {}) }, content: { kind: "base", version: 1, value } });

async function claimedJournal(store, runId = "run-1") {
  await agentWithRevision(store);
  await store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" });
  return store.journal(await store.claim(runId, "runner-a", { leaseMs: 60_000 }));
}

test("the single-document form: a run's decisions are the agentrun.decisions document's receipts", async (t) => {
  const { store } = await storeOn(t);
  const journal = await claimedJournal(store);
  const id = await journal.mintId();
  await commitWrites(journal, [sessionDoc(id, "agentrun.decisions", undefined, { receipts: [{ v: 1, call: "a" }, { v: 1, call: "b" }] })], context);
  assert.deepEqual(await decisionsOverStore(store, "run-1", context), [{ v: 1, call: "a" }, { v: 1, call: "b" }]);
});

test("the keyed form: the count document and the family rows, in order", async (t) => {
  const { store } = await storeOn(t);
  const journal = await claimedJournal(store);
  const [countId, row0, row1] = [await journal.mintId(), await journal.mintId(), await journal.mintId()];
  await commitWrites(journal, [
    sessionDoc(countId, "agentrun.decisions.count", undefined, { count: 2 }),
    sessionDoc(row0, "agentrun.decisions", decisionKey(0), { v: 1, place: 0 }),
    sessionDoc(row1, "agentrun.decisions", decisionKey(1), { v: 1, place: 1 }),
  ], context);
  assert.deepEqual(await decisionsOverStore(store, "run-1", context), [{ v: 1, place: 0 }, { v: 1, place: 1 }]);
});

test("a run with no decisions reads none", async (t) => {
  const { store } = await storeOn(t);
  await claimedJournal(store);
  assert.deepEqual(await decisionsOverStore(store, "run-1", context), []);
  assert.deepEqual(await decisionsOverStore(store, "no-such-run", context), []);
});
