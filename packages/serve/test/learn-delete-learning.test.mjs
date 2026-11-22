// An agent's learning, deleted (learn/delete.ts deleteLearning, the learning half of an agent's delete: its caller stops
// the agent's runs and learning work, calls it, then deletes the agent's store rows): its learning store (every file,
// its git history and audits.jsonl, the local folder whole) and the learning records the store keeps by agent (promotions, grades) go, and
// nothing of another agent's. It refuses while a compile, a check or an audit of the agent is in flight (a run of it not
// ended), leaving everything; a second call finds nothing and does nothing, so a call again after a crash finishes the
// job.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoOf } from "./learn-support.mjs";
import { storeOn } from "./store-helpers.mjs";

const { deleteLearning, LearningInFlight } = await import("../dist/learn/delete.js");
const { seedOf } = await import("../dist/learning.js");
const { learningStoreOf } = await import("../dist/learn/store-of.js");
const { promotionsOf, gradesOf } = await import("../dist/learn/promote.js");
const { auditChange, ledgerOf, readAudits } = await import("../dist/learn/audit.js");
const { writeLearning } = await import("../dist/learn/folder.js");

const KEYS = (agentId) => [`learning.promotions.${agentId}`, `learning.grades.${agentId}`];
const ROW = { run: "run-1", shadow_run: "audit.run-1", workflow: "answer", digest: "a".repeat(16), promoted_at: null, source: "shadow", agreed: true, served_cost: 0.1, shadow_cost: 0.4, at: "2026-11-17T06:00:00.000Z" };

/** Agents `agent-1` and `agent-10` (a name the first's is the start of), each with a learning folder (seeded: its git
 *  history and snapshot, and an audits.jsonl row) and its learning records in the store. */
async function learned(t) {
  const data = mkdtempSync(join(tmpdir(), "delete-learning-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const { store } = await storeOn(t);
  for (const agentId of ["agent-1", "agent-10"]) {
    await store.agents.create({ id: agentId, name: agentId }, { id: `rev-${agentId}`, kind: "agentic", body: { instructions: "Go.", learning: true } });
    await seedOf(data, agentId);
    // The ledger is read from the store's main, so its row is committed there as the host appends one.
    await writeLearning(learningStoreOf(data, agentId), async (folder) => ({ result: null, change: auditChange(await ledgerOf(folder), [ROW]).change }));
    await store.settings.put(`learning.promotions.${agentId}`, { v: 1, items: [{ workflow: "answer", digest: "a".repeat(16), at: "2026-11-17T06:00:00.000Z", decided: "promote", reason: "checked" }] });
    await store.settings.put(`learning.grades.${agentId}`, { v: 1, items: [{ run: "run-1", correct: true, source: "feedback", at: "2026-11-17T06:00:00.000Z", path: "agent" }] });
  }
  return { data, store };
}

/** What the server's store and the learning store hold of `agentId`'s learning: `files`, main's paths (none: no main). */
async function held(store, data, agentId) {
  const learning = learningStoreOf(data, agentId);
  const head = await learning.head();
  const files = head ? (await learning.read(head)).map((file) => file.path) : [];
  const settings = [];
  for (const key of KEYS(agentId)) if ((await store.settings.get(key)) !== undefined) settings.push(key);
  return { files, settings, promotions: (await promotionsOf(store.settings, agentId)).length, grades: (await gradesOf(store.settings, agentId)).length, audits: (await readAudits(learning)).length };
}

test("deleteLearning removes the agent's learning folder (its git history and audits.jsonl) and its learning records, nothing of another agent's; a second call does nothing", async (t) => {
  const { data, store } = await learned(t);
  const before = await held(store, data, "agent-1");
  assert.ok(before.files.includes("audits.jsonl"), JSON.stringify(before));
  assert.deepEqual([before.settings.length, before.promotions, before.grades, before.audits], [2, 1, 1, 1]);

  const first = await deleteLearning(store, "agent-1", learningStoreOf(data, "agent-1"));
  assert.deepEqual(first, { learned: true, records: 2 });
  assert.deepEqual(await held(store, data, "agent-1"), { files: [], settings: [], promotions: 0, grades: 0, audits: 0 }, "no read returns anything of its learning");
  assert.equal(existsSync(repoOf(data, "agent-1")), false, "the folder is gone whole");
  const other = await held(store, data, "agent-10");
  assert.deepEqual([other.settings.length, other.promotions, other.grades, other.audits], [2, 1, 1, 1], "another agent's learning stays");
  assert.ok(other.files.includes("audits.jsonl"));

  assert.deepEqual(await deleteLearning(store, "agent-1", learningStoreOf(data, "agent-1")), { learned: false, records: 0 }, "a second call finds nothing");
  assert.deepEqual(await held(store, data, "agent-1"), { files: [], settings: [], promotions: 0, grades: 0, audits: 0 });
});

test("deleteLearning refuses while a run of the agent is not ended (its compile, a check's replay or an audit's shadow may be at work), and removes nothing", async (t) => {
  const { data, store } = await learned(t);
  await store.runs.create({ id: "audit.run-1", agentId: "agent-1", revisionId: "rev-agent-1" }, { body: { input: { content: "Go." }, title: "t", place: { mode: "runner" }, audit: { of: "run-1", workflow: "answer", digest: "a".repeat(16) } } });
  await assert.rejects(deleteLearning(store, "agent-1", learningStoreOf(data, "agent-1")), (error) => error instanceof LearningInFlight && /audit\.run-1/.test(error.message));
  const kept = await held(store, data, "agent-1");
  assert.deepEqual([kept.settings.length, kept.promotions, kept.grades, kept.audits], [2, 1, 1, 1], "nothing removed");
  // Its caller stops it; then the delete goes through.
  const claim = await store.claim("audit.run-1", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "stopped", costUsd: 0 });
  await deleteLearning(store, "agent-1", learningStoreOf(data, "agent-1"));
  assert.deepEqual(await held(store, data, "agent-1"), { files: [], settings: [], promotions: 0, grades: 0, audits: 0 });
});
