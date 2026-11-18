// An agent's learning, deleted (learn/delete.ts deleteLearning, the learning half of an agent's delete: its caller stops
// the agent's runs and learning work, calls it, then deletes the agent's store rows): its learning folder (every file,
// its git history and audits.jsonl) and the learning records the store keeps by agent (promotions, grades, evals) go,
// and nothing of another agent's. It refuses while a compile, a check or an audit of the agent is in flight (a run of it
// not ended, or a learning run grading one), leaving everything; a second call finds nothing and does nothing, so a call
// again after a crash finishes the job.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { deleteLearning, LearningInFlight } = await import("../dist/learn/delete.js");
const { learningFolderOf, seedOf } = await import("../dist/learning.js");
const { promotionsOf, gradesOf } = await import("../dist/learn/promote.js");
const { auditChange, ledgerOf, readAudits } = await import("../dist/learn/audit.js");
const { writeLearning } = await import("../dist/learn/folder.js");

const KEYS = (agentId) => [`learning.promotions.${agentId}`, `learning.grades.${agentId}`, `learning.evals.${agentId}`];
const ROW = { run: "run-1", shadow_run: "audit.run-1", workflow: "answer", digest: "a".repeat(16), promoted_at: null, source: "shadow", agreed: true, served_cost: 0.1, shadow_cost: 0.4, at: "2026-11-17T06:00:00.000Z" };

/** Agents `agent-1` and `agent-10` (a name the first's is the start of), each with a learning folder (seeded: its git
 *  history and snapshot, a note and an audits.jsonl row) and its learning records in the store. */
async function learned(t) {
  const data = mkdtempSync(join(tmpdir(), "delete-learning-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const { store } = await storeOn(t);
  for (const agentId of ["agent-1", "agent-10"]) {
    await store.agents.create({ id: agentId, name: agentId }, { id: `rev-${agentId}`, kind: "agentic", body: { instructions: "Go.", learning: true } });
    await seedOf(data, agentId);
    const { workspace, end } = learningFolderOf(data, agentId);
    // The ledger is read from the folder's main, so its row is committed there as the host appends one.
    await writeLearning(workspace, async (folder) => ({ result: null, change: auditChange(await ledgerOf(folder), [ROW]).change }));
    await end();
    await store.settings.put(`learning.promotions.${agentId}`, { v: 1, items: [{ workflow: "answer", digest: "a".repeat(16), at: "2026-11-17T06:00:00.000Z", decided: "promote", reason: "checked" }] });
    await store.settings.put(`learning.grades.${agentId}`, { v: 1, items: [{ run: "run-1", correct: true, source: "feedback", at: "2026-11-17T06:00:00.000Z", path: "agent" }] });
    await store.settings.put(`learning.evals.${agentId}`, { v: 1, items: [] });
  }
  return { data, store };
}

/** What the store and the folder hold of `agentId`'s learning. */
async function held(store, data, agentId) {
  const { workspace, end } = learningFolderOf(data, agentId);
  try {
    const entries = await workspace.list("").then((list) => list.map((one) => one.name)).catch((error) => (error.code === "NOT_FOUND" ? [] : Promise.reject(error)));
    const settings = [];
    for (const key of KEYS(agentId)) if ((await store.settings.get(key)) !== undefined) settings.push(key);
    return { entries, settings, promotions: (await promotionsOf(store.settings, agentId)).length, grades: (await gradesOf(store.settings, agentId)).length, audits: (await readAudits(workspace)).length };
  } finally {
    await end();
  }
}

test("deleteLearning removes the agent's learning folder (its git history and audits.jsonl) and its learning records, nothing of another agent's; a second call does nothing", async (t) => {
  const { data, store } = await learned(t);
  const before = await held(store, data, "agent-1");
  assert.ok(before.entries.includes(".git") && before.entries.includes("audits.jsonl"), JSON.stringify(before));
  assert.deepEqual([before.settings.length, before.promotions, before.grades, before.audits], [3, 1, 1, 1]);

  const first = await deleteLearning(store, "agent-1", learningFolderOf(data, "agent-1"));
  assert.ok(first.files > 0 && first.records === 3, JSON.stringify(first));
  assert.deepEqual(await held(store, data, "agent-1"), { entries: [], settings: [], promotions: 0, grades: 0, audits: 0 }, "no read returns anything of its learning");
  const other = await held(store, data, "agent-10");
  assert.deepEqual([other.settings.length, other.promotions, other.grades, other.audits], [3, 1, 1, 1], "another agent's learning stays");
  assert.ok(other.entries.includes(".git"));

  assert.deepEqual(await deleteLearning(store, "agent-1", learningFolderOf(data, "agent-1")), { files: 0, records: 0 }, "a second call finds nothing");
  assert.deepEqual(await held(store, data, "agent-1"), { entries: [], settings: [], promotions: 0, grades: 0, audits: 0 });
});

test("deleteLearning refuses while a run of the agent is not ended (its compile, a check's replay or an audit's shadow may be at work), and removes nothing", async (t) => {
  const { data, store } = await learned(t);
  await store.runs.create({ id: "audit.run-1", agentId: "agent-1", revisionId: "rev-agent-1" }, { body: { input: { content: "Go." }, title: "t", place: { mode: "runner" }, audit: { of: "run-1", workflow: "answer", digest: "a".repeat(16) } } });
  await assert.rejects(deleteLearning(store, "agent-1", learningFolderOf(data, "agent-1")), (error) => error instanceof LearningInFlight && /audit\.run-1/.test(error.message));
  const kept = await held(store, data, "agent-1");
  assert.deepEqual([kept.settings.length, kept.promotions, kept.grades, kept.audits], [3, 1, 1, 1], "nothing removed");
  // Its caller stops it; then the delete goes through.
  const claim = await store.claim("audit.run-1", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "stopped", costUsd: 0 });
  await deleteLearning(store, "agent-1", learningFolderOf(data, "agent-1"));
  assert.deepEqual(await held(store, data, "agent-1"), { entries: [], settings: [], promotions: 0, grades: 0, audits: 0 });
});

/** A learning batch's records as learning-batch.ts keeps them (the agent's index, each row, the header), `status` its state;
 *  `header` false for a create stopped before its header. */
async function batch(store, agentId, id, status, { header = true } = {}) {
  await store.settings.put(`learning_batches/${agentId}`, [...((await store.settings.get(`learning_batches/${agentId}`)) ?? []), id]);
  await store.settings.put(`learning_batch/${id}/row/1`, { n: 1, state: status === "running" ? "pending" : "done", input: { q: "Q" }, reference: "42" });
  if (header) await store.settings.put(`learning_batch/${id}`, { id, agent_id: agentId, status, total: 1 });
}
const batchKeys = async (store) => (await store.settings.all({ prefix: "learning_batch" })).map((row) => row.key).sort();

test("deleteLearning removes the agent's learning batches (each one's rows and header, its index last), one whose create stopped before its header too, and nothing of another agent's; it refuses while one still runs, removing nothing", async (t) => {
  const { data, store } = await learned(t);
  await batch(store, "agent-1", "lb_0000000000000001", "completed");
  await batch(store, "agent-1", "lb_0000000000000002", "running");
  await batch(store, "agent-1", "lb_0000000000000003", "running", { header: false });
  await batch(store, "agent-10", "lb_0000000000000010", "completed");
  const before = await batchKeys(store);

  await assert.rejects(deleteLearning(store, "agent-1", learningFolderOf(data, "agent-1")), (error) => error instanceof LearningInFlight && JSON.stringify(error.runs) === JSON.stringify(["lb_0000000000000002"]));
  assert.deepEqual(await batchKeys(store), before, "nothing removed while one runs");
  assert.equal((await held(store, data, "agent-1")).settings.length, 3);

  await store.settings.put("learning_batch/lb_0000000000000002", { id: "lb_0000000000000002", agent_id: "agent-1", status: "cancelled", total: 1 });
  const done = await deleteLearning(store, "agent-1", learningFolderOf(data, "agent-1"));
  assert.equal(done.records, 3 + 3 + 2 + 1, "its 3 records, 3 rows, 2 headers and its index");
  assert.deepEqual(await batchKeys(store), ["learning_batch/lb_0000000000000010", "learning_batch/lb_0000000000000010/row/1", "learning_batches/agent-10"], "another agent's batch stays");
  assert.deepEqual(await deleteLearning(store, "agent-1", learningFolderOf(data, "agent-1")), { files: 0, records: 0 }, "a second call finds nothing");
});
