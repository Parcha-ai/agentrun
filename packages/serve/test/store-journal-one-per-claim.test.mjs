// One journal per claim: store.journal(claim) asked twice on one claim gives the run's one journal (pi assumes one
// Storage per owner), so two callers never mint the same ids and a task committed from each is two tasks, never one
// silently overwritten. Two runs' journals stay apart, and a journal closed is not handed out again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { queued, storeOn } from "./store-helpers.mjs";

const context = BACKGROUND_CONTEXT;
const task = (id, mark) => ({ type: "task", value: { id, conversationId: 1, kind: "test.task", version: 1, input: { mark }, state: { status: "pending" }, background: false, abortRequested: false } });

test("two store.journal(claim) calls on one claim mint no id twice, and a task committed through each is two tasks", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const one = store.journal(claim);
  const two = store.journal(claim);
  await commitWrites(one, [{ type: "conversation", value: { id: 1 } }], context);
  const a = await one.mintId();
  const b = await two.mintId();
  assert.notEqual(Number(a), Number(b), "no id minted twice");
  await commitWrites(one, [task(a, "a")], context);
  await commitWrites(two, [task(b, "b")], context);
  const marks = [];
  for (const id of [a, b]) marks.push((await one.task(id, context))?.input.mark);
  assert.deepEqual(marks, ["a", "b"], "two tasks, neither overwritten");
});

test("the store keeps no journal it no longer hands out: none once a journal is closed, none once its claim is released; an open one is shared", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const journal = store.journal(claim);
  assert.equal(store.journal(claim), journal, "two calls while it is open give the same journal");
  assert.equal(store.openJournals, 1, "one kept while open");
  await journal.close(context);
  assert.equal(store.openJournals, 0, "none kept once it is closed");
  await queued(store, "run-2");
  const other = await store.claim("run-2", "runner-a", { leaseMs: 30_000 });
  store.journal(other);
  assert.equal(store.openJournals, 1);
  await store.release(other);
  assert.equal(store.openJournals, 0, "none kept once its claim is released");
});

test("two runs' journals stay apart, and a closed journal is not handed out again", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  await queued(store, "run-2");
  const c1 = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const c2 = await store.claim("run-2", "runner-a", { leaseMs: 30_000 });
  const j1 = store.journal(c1);
  const j2 = store.journal(c2);
  await commitWrites(j1, [{ type: "conversation", value: { id: 1 } }], context);
  await commitWrites(j2, [{ type: "conversation", value: { id: 1 } }], context);
  assert.equal(Number(await j1.mintId()), Number(await j2.mintId()), "each run mints in its own namespace");
  await j1.close(context);
  const again = store.journal(c1);
  await assert.doesNotReject(commitWrites(again, [{ type: "entry", value: { id: await again.mintId(), conversationId: 1, kind: "message" } }], context), "a new journal after a close");
});
