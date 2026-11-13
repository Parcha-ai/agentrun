// GET /v2/stats' counts and cost sums over the one store (store-reads/stats.ts): the same StoreStats the old store gave,
// from A's run rows and agents. A run's own archive hides it from the shown counts; an archived agent moves all its runs to
// archivedRuns and itself to archivedAgents. Cost sums the ended runs that carried one; a running or no-cost run is unknown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { stats } = await import("../dist/store-reads/stats.js");

async function create(store, id, agentId, revisionId = "rev-1") {
  await store.runs.create({ id, agentId, revisionId });
}
async function end(store, id, patch) {
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, patch);
}

test("stats counts runs by state, sums the known costs, and keeps archived apart", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent A" }, { id: "rev-1", kind: "agentic", body: { instructions: "x" } });
  await store.agents.create({ id: "agent-2", name: "Agent B" }, { id: "rev-2", kind: "agentic", body: { instructions: "x" } });
  await store.agents.create({ id: "agent-3", name: "Agent C" }, { id: "rev-3", kind: "agentic", body: { instructions: "x" } });

  // agent-1: a completion with cost, a failure with none, a still-running (queued) run, an escalation with cost, and a run
  // the owner archived.
  await create(store, "r-done", "agent-1");
  await end(store, "r-done", { state: "ended", outcome: "completed", costUsd: 1 });
  await create(store, "r-fail", "agent-1");
  await end(store, "r-fail", { state: "failed" });
  await create(store, "r-queue", "agent-1");
  await create(store, "r-esc", "agent-1");
  await end(store, "r-esc", { state: "ended", outcome: "escalated", costUsd: 2 });
  await create(store, "r-arch", "agent-1");
  await end(store, "r-arch", { state: "ended", outcome: "completed", costUsd: 5 });
  await store.runs.archive("r-arch", true);

  // agent-2: one completion, then the whole agent is archived.
  await create(store, "r-b", "agent-2", "rev-2");
  await end(store, "r-b", { state: "ended", outcome: "completed", costUsd: 3 });
  await store.agents.archive("agent-2", true);

  const s = await stats(store);
  assert.equal(s.agents, 2, "agent-1 and agent-3");
  assert.equal(s.archivedAgents, 1, "agent-2");
  assert.deepEqual(s.runs, { total: 4, running: 1, completed: 1, failed: 1, stopped: 0, escalated: 1 }, "agent-1's shown runs; the archived one is apart");
  assert.equal(s.archivedRuns, 2, "agent-1's archived run and agent-2's run");
  assert.deepEqual(s.cost, { usd: 3, known: 2, unknown: 2 }, "the completion and the escalation are known; the failure and the queued run are not");
  assert.deepEqual(s.byAgent, [{ id: "agent-1", name: "Agent A", runs: 4 }, { id: "agent-3", name: "Agent C", runs: 0 }], "by name, archived agent left out");
  assert.deepEqual(s.running, ["r-queue"], "the queued run, which is not terminal and not archived");
});

test("an empty store: no agents, no runs, cost unknown is null", async (t) => {
  const { store } = await storeOn(t);
  const s = await stats(store);
  assert.deepEqual(s, { agents: 0, archivedAgents: 0, runs: { total: 0, running: 0, completed: 0, failed: 0, stopped: 0, escalated: 0 }, archivedRuns: 0, cost: { usd: null, known: 0, unknown: 0 }, byAgent: [], running: [] });
});
