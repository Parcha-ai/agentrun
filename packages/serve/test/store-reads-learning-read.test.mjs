// A run's learning end from the one store: when its job answered, what the job cost and what its learning cost, as its
// kept row says (store-reads/learning.ts runLearningEnd), whatever the round kept.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const reads = await import("../dist/store-reads/learning.js");

test("a run's learning end from the store keeps when its job answered, what the job cost and what looking back cost, as its kept row says", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", learning: true } });
  const answered = { answered_at: "2026-11-09T06:00:00.000Z", job_cost_usd: 0.3, look_back_usd: 0.12 };
  const merged = { state: "merged", reason: null, merged: "a".repeat(40), corrections: 1, detail: "Learned one correction." };
  for (const [id, proposal] of [["run-1", { state: "dropped", reason: "empty", detail: "Nothing to keep.", ...answered }], ["run-2", { ...merged, ...answered }]]) {
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: "t", place: { mode: "runner" } } });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal } }] });
    const end = await reads.runLearningEnd(store, id);
    assert.deepEqual({ answered_at: end?.answered_at, job_cost_usd: end?.job_cost_usd, look_back_usd: end?.look_back_usd }, answered, `${proposal.state}: ${JSON.stringify(end)}`);
  }
});
