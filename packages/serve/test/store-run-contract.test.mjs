// The run-row read contract the server's run readers need from the one store (design 2.1): an ended run's outcome
// (completed or escalated — the v2 status maps escalated to completed with a review, exactly as today), a run's own
// archive time, the session an imported run came from, and the origin key a run was started under (so a retry under the
// same key finds the run, even if the server went down before its answer was stored — the origin is written in the run's
// own transaction, not with the kept response). E2 writes outcome and origin in its run path; Store.importRun writes
// imported_from; the server's archive route writes archived_at. The readers (listRuns, readRun, runOfOrigin, stats,
// analytics) read them back here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { runOf, StoreConstraint } = await import("../dist/store/index.js");

/** A claimed run on the store, its claim held. */
async function claimed(store, runId = "run-1") {
  if (!(await store.agents.get("agent-1"))) await agentWithRevision(store);
  await store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" });
  return store.claim(runId, "runner-a", { leaseMs: 60_000 });
}

test("an ended run's outcome is set in its end commit and read back; a plain completion leaves it null", async (t) => {
  const { store } = await storeOn(t);
  const escalated = await claimed(store, "run-escalated");
  await store.runs.update(escalated, { state: "ended", outcome: "escalated" });
  assert.equal((await store.runs.get("run-escalated")).outcome, "escalated");

  const completed = await claimed(store, "run-completed");
  await store.runs.update(completed, { state: "ended" });
  assert.equal((await store.runs.get("run-completed")).outcome, null, "a plain completion sets no outcome");
});

test("the store refuses an outcome that is not completed or escalated", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimed(store, "run-bad");
  await assert.rejects(store.runs.update(claim, { state: "ended", outcome: "needs_review" }), (e) => e instanceof StoreConstraint || /outcome/i.test(String(e)), "not a stored outcome");
});

test("a run's own archive time: archive sets it, unarchive clears it, and a list filters on it", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-a", agentId: "agent-1", revisionId: "rev-1" });
  await store.runs.create({ id: "run-b", agentId: "agent-1", revisionId: "rev-1" });
  assert.equal((await store.runs.get("run-a")).archivedAt, null);

  clock.now += 1_000;
  await store.runs.archive("run-a", true);
  assert.equal((await store.runs.get("run-a")).archivedAt, clock.now, "archived at the store's clock");

  const firstArchivedAt = clock.now;
  clock.now += 5_000;
  await store.runs.archive("run-a", true);
  assert.equal((await store.runs.get("run-a")).archivedAt, firstArchivedAt, "re-archiving an already-archived run keeps the first time");

  assert.deepEqual((await store.runs.list({ archived: true })).map((r) => r.id), ["run-a"], "only the archived one");
  assert.deepEqual((await store.runs.list({ archived: false })).map((r) => r.id).sort(), ["run-b"], "only the ones that are not");

  await store.runs.archive("run-a", false);
  assert.equal((await store.runs.get("run-a")).archivedAt, null, "unarchived");
});

test("a run's imported_from reads back as { source, session }, and a run of none reads null", async (t) => {
  // The read contract: runOf parses the column; Store.importRun (a later commit) is its writer.
  assert.deepEqual(
    runOf({ id: "r", agent_id: "a", revision_id: "v", state: "ended", epoch: 1, runner: null, claimed_until: null, wake_at: null, backoff_until: null, cost_usd: null, metrics: null, summary: null, started_at: 0, ended_at: 1, outcome: "completed", archived_at: null, imported_from: JSON.stringify({ source: "codex", session: "s-1" }), sign_in_handed: null }).importedFrom,
    { source: "codex", session: "s-1" },
  );
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-live", agentId: "agent-1", revisionId: "rev-1" });
  assert.equal((await store.runs.get("run-live")).importedFrom, null, "a run started here is imported from nothing");
});

test("a run started under an origin key is found by runOfOrigin, with the fingerprint recorded then", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-keyed", agentId: "agent-1", revisionId: "rev-1", origin: { key: "k-1", fingerprint: "fp-1" } });
  assert.deepEqual(await store.runOfOrigin("k-1"), { runId: "run-keyed", fingerprint: "fp-1" });

  await store.runs.create({ id: "run-nofp", agentId: "agent-1", revisionId: "rev-1", origin: { key: "k-2" } });
  assert.deepEqual(await store.runOfOrigin("k-2"), { runId: "run-nofp", fingerprint: null }, "no fingerprint recorded");

  assert.equal(await store.runOfOrigin("never"), undefined, "a key that started no run");
});

test("the origin row is written in the run's own transaction: a second run under a key already used is refused", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1", origin: { key: "k", fingerprint: "a" } });
  await assert.rejects(store.runs.create({ id: "run-2", agentId: "agent-1", revisionId: "rev-1", origin: { key: "k", fingerprint: "b" } }), (e) => e instanceof StoreConstraint, "the key is one run's");
  // The first run and its origin stand.
  assert.deepEqual(await store.runOfOrigin("k"), { runId: "run-1", fingerprint: "a" });
});
