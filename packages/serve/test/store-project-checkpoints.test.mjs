import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const checkpoint = runId => ({ version: 1, status: "candidate", sourceId: "a".repeat(64), runId, epoch: 1, baselineRevision: "rev-1", baselineDigest: "b".repeat(64), revision: `project-${runId}`, digest: "c".repeat(64) });
async function opened(store, id, agentId = "agent-1", revisionId = "rev-1") {
  await store.runs.create({ id, agentId, revisionId });
  const claim = await store.claim(id, "fixture", { leaseMs: 60_000 }), journal = store.journal(claim);
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  return { claim, journal };
}
async function finish(journal, data, extra = {}) {
  const id = await journal.mintId();
  journal.stage({ run: { state: "ended" }, effect: id });
  await commitWrites(journal, [{ type: "entry", value: { id, conversationId: 1, kind: "agentrun.end", data: { state: "ended", projectCheckpoint: data, ...extra } } }], BACKGROUND_CONTEXT);
  return id;
}

test("checkpoint discovery reads only committed terminal receipts, scoped to their agent and optional run", async t => {
  const { store } = await storeOn(t); await agentWithRevision(store);
  const { journal } = await opened(store, "one"), own = checkpoint("one");
  const pending = await journal.mintId(); journal.stage({ run: { state: "ended" }, effect: pending });
  assert.deepEqual(await store.runs.projectCheckpoints({ agentId: "agent-1" }), [], "staged but uncommitted end is not a checkpoint");
  const id = await finish(journal, own, { output: "unrelated output".repeat(65_536) });
  await store.agents.create({ id: "other", name: "Other" }, { id: "rev-other", kind: "agentic", body: {} });
  const other = await opened(store, "other-run", "other", "rev-other"); await finish(other.journal, checkpoint("other-run"));
  assert.deepEqual(await store.runs.projectCheckpoints({ agentId: "agent-1" }), [{ runId: "one", revisionId: "rev-1", entryId: id, checkpoint: own }]);
  assert.deepEqual(await store.runs.projectCheckpoints({ agentId: "agent-1", runId: "missing" }), []);
  assert.deepEqual(await store.runs.projectCheckpoints({ agentId: "other", runId: "one" }), []);
  await journal.close(); await other.journal.close();
});

test("checkpoint discovery ignores tool payload lookalikes and excludes purged run content", async t => {
  const { store } = await storeOn(t); await agentWithRevision(store);
  const { journal } = await opened(store, "one");
  await commitWrites(journal, [{ type: "entry", value: { id: await journal.mintId(), conversationId: 1, kind: "agentrun.call.end", data: { projectCheckpoint: checkpoint("one") } } }], BACKGROUND_CONTEXT);
  assert.deepEqual(await store.runs.projectCheckpoints({ agentId: "agent-1" }), []);
  await finish(journal, checkpoint("one")); await journal.close();
  await store.runs.purge("one", { meters: null, spend: { usd: null }, learning: null });
  assert.deepEqual(await store.runs.projectCheckpoints({ agentId: "agent-1" }), []);
});

test("unrelated Unicode in terminal records preserves exact checkpoint metadata on both dialects", async t => {
  const { store } = await storeOn(t); await agentWithRevision(store);
  for (const [index, text] of ["\u0000", "\ud800", "\udfff", "😀"].entries()) {
    const runId = `unicode-${index}`, { journal } = await opened(store, runId);
    const own = checkpoint(runId); await finish(journal, own, { summary: text }); await journal.close();
    const kept = await store.runs.projectCheckpoints({ agentId: "agent-1", runId });
    assert.equal(kept.length, 1); assert.deepEqual(kept[0].checkpoint, own);
  }
});

test("an uncertain checkpoint retains its fixed diagnostic stage without unrelated terminal content", async t => {
  const { store } = await storeOn(t); await agentWithRevision(store);
  const { journal } = await opened(store, "uncertain");
  const own = { version: 1, status: "uncertain", sourceId: "a".repeat(64), runId: "uncertain", epoch: 1, reason: "project_not_settled", stage: "sync" };
  const id = await finish(journal, own, { summary: "unrelated private output".repeat(10_000) }); await journal.close();
  assert.deepEqual(await store.runs.projectCheckpoints({ agentId: "agent-1" }), [{ runId: "uncertain", revisionId: "rev-1", entryId: id, checkpoint: own }]);
});
