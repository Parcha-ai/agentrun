// An agent's learning, deleted (learn/delete.ts deleteLearning, the learning half of an agent's delete: its caller stops
// the agent's runs and learning work, calls it, then deletes the agent's store rows): every learning row the store keeps
// for it (its notes and workflows with every save, its promotions, grades and audits) goes, and nothing of another
// agent's. It refuses while a compile, a check or an audit of the agent is in flight (a run of it not ended), leaving
// everything; a second call finds nothing and does nothing, so a call again after a crash finishes the job.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { putLearning } from "./learn-support.mjs";

const { deleteLearning, LearningInFlight } = await import("../dist/learn/delete.js");
const { promotionsOf, gradesOf } = await import("../dist/learn/promote.js");
const { addAuditLines, readAudits } = await import("../dist/learn/audit.js");

const ROW = { run: "run-1", shadow_run: "audit.run-1", workflow: "answer", digest: "a".repeat(16), promoted_at: null, source: "shadow", agreed: true, served_cost: 0.1, shadow_cost: 0.4, at: "2026-11-17T06:00:00.000Z" };
const PROMOTION = { workflow: "answer", digest: "a".repeat(16), at: "2026-11-17T06:00:00.000Z", decided: "promote", reason: "checked" };
const GRADE = { run: "run-1", correct: true, source: "feedback", at: "2026-11-17T06:00:00.000Z", path: "agent" };

/** Agents `agent-1` and `agent-10` (a name the first's is the start of), each with learning rows: a note and a workflow
 *  saved, an audit row, a promotion and a grade. */
async function learned(t) {
  const { store } = await storeOn(t);
  for (const agentId of ["agent-1", "agent-10"]) {
    await store.agents.create({ id: agentId, name: agentId }, { id: `rev-${agentId}`, kind: "agentic", body: { instructions: "Go.", learning: true } });
    await putLearning(store, agentId, { "corrections.md": "Answer in one line.", "workflows/answer/workflow.json": "{}", "workflows/answer/README.md": "---\nname: answer\ndescription: Answers\n---\n" }, { runId: "run-1" });
    await addAuditLines(store.learning, agentId, [ROW]);
    await store.learning.addRecord(agentId, "promotion", { runId: null, workflow: PROMOTION.workflow, digest: PROMOTION.digest, data: PROMOTION });
    await store.learning.addRecord(agentId, "grade", { runId: "run-1", workflow: null, digest: null, data: GRADE });
  }
  return { store };
}

/** What the store holds of `agentId`'s learning. */
async function held(store, agentId) {
  const newest = await store.learning.newest(agentId);
  const { total } = await store.learning.saves(agentId);
  return { items: newest?.items.length ?? 0, saves: total, promotions: (await promotionsOf(store.learning, agentId)).length, grades: (await gradesOf(store.learning, agentId)).length, audits: (await readAudits(store.learning, agentId)).length };
}
const NOTHING = { items: 0, saves: 0, promotions: 0, grades: 0, audits: 0 };
const LEARNED = { items: 2, saves: 1, promotions: 1, grades: 1, audits: 1 };

test("deleteLearning removes the agent's learning rows (its items with every save, its promotions, grades and audits), nothing of another agent's; a second call does nothing", async (t) => {
  const { store } = await learned(t);
  assert.deepEqual(await held(store, "agent-1"), LEARNED);

  assert.deepEqual(await deleteLearning(store, "agent-1"), { records: 0 });
  assert.deepEqual(await held(store, "agent-1"), NOTHING, "no read returns anything of its learning");
  assert.deepEqual(await held(store, "agent-10"), LEARNED, "another agent's learning stays");

  assert.deepEqual(await deleteLearning(store, "agent-1"), { records: 0 }, "a second call finds nothing");
  assert.deepEqual(await held(store, "agent-1"), NOTHING);
});

test("deleteLearning refuses while a run of the agent is not ended (its compile, a check's replay or an audit's shadow may be at work), and removes nothing", async (t) => {
  const { store } = await learned(t);
  await store.runs.create({ id: "audit.run-1", agentId: "agent-1", revisionId: "rev-agent-1" }, { body: { input: { content: "Go." }, title: "t", place: { mode: "runner" }, audit: { of: "run-1", workflow: "answer", digest: "a".repeat(16) } } });
  await assert.rejects(deleteLearning(store, "agent-1"), (error) => error instanceof LearningInFlight && /audit\.run-1/.test(error.message));
  assert.deepEqual(await held(store, "agent-1"), LEARNED, "nothing removed");
  // Its caller stops it; then the delete goes through.
  const claim = await store.claim("audit.run-1", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "stopped", costUsd: 0 });
  await deleteLearning(store, "agent-1");
  assert.deepEqual(await held(store, "agent-1"), NOTHING);
});
