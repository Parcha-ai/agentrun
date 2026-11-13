// GET /v2/stats' analytics over the one store (store-reads/analytics.ts): the same StoreAnalytics the old store gave, from
// A's run rows and the metrics their end commits wrote. A pending run is counted at its end's state in the totals alone; a
// run's tokens, cost and effort come from its row's metrics; by harness and effort, by day, by source; archived runs and
// those outside [from, to) or another agent are left out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn, T0 } from "./store-helpers.mjs";

const { analytics } = await import("../dist/store-reads/analytics.js");

const DAY = 86_400_000;
const metrics = (over = {}) => ({ input: 100, cacheRead: 10, cacheWrite: 5, output: 20, requests: 3, unmetered: 1, activeMs: 2000, effort: "high", tools: { read: { calls: 4, errors: 1 }, write: { calls: 2, errors: 0 } }, ...over });

async function end(store, id, patch) {
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, patch);
}

test("totals, time and tools over a run's row metrics, with a pending run counted in the totals alone", async (t) => {
  const { store } = await storeOn(t); // clock stays at T0
  await store.agents.create({ id: "agent-1", name: "A" }, { id: "rev-1", kind: "agentic", body: { instructions: "x" } });
  for (const id of ["r1", "r2", "r3", "r4"]) await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" });
  await end(store, "r1", { state: "ended", outcome: "completed", costUsd: 1, metrics: metrics(), endedAt: T0 + 5000 });
  await end(store, "r2", { state: "failed", endedAt: T0 + 1000 });
  // r3 stays queued; r4 is queued but pending (its end on the caller's way).

  const a = await analytics(store, { pending: { r4: "completed" } });
  assert.deepEqual(a.totals, {
    runs: 4, completed: 2, needsReview: 0, failed: 1, runsWithMetrics: 1, tokens: 135, costUsd: 1, unknownCostRuns: 2,
    input: 100, cacheRead: 10, cacheWrite: 5, output: 20, requests: 3, unmetered: 1,
  });
  assert.deepEqual(a.time, { endedRuns: 2, wallMs: 6000, activeRuns: 1, activeMs: 2000 });
  assert.deepEqual(a.tools, [{ tool: "read", calls: 4, errors: 1 }, { tool: "write", calls: 2, errors: 0 }]);
  assert.deepEqual(a.byHarnessEffort, [
    { harness: "pi", effort: null, runs: 2, completed: 0, needsReview: 0, failed: 1, runsWithMetrics: 0, tokens: 0, costUsd: null, unknownCostRuns: 2 },
    { harness: "pi", effort: "high", runs: 1, completed: 1, needsReview: 0, failed: 0, runsWithMetrics: 1, tokens: 135, costUsd: 1, unknownCostRuns: 0 },
  ]);
  assert.deepEqual(a.byDay, [{ day: "2026-11-08", runs: 3, completed: 1, needsReview: 0, failed: 1, runsWithMetrics: 1, tokens: 135, costUsd: 1, unknownCostRuns: 2 }]);
  assert.deepEqual(a.bySource, [{ source: "live", runs: 3, completed: 1, needsReview: 0, failed: 1, runsWithMetrics: 1, tokens: 135, costUsd: 1, unknownCostRuns: 2 }]);
});

test("by harness and effort across agents, an escalation counted as completed and needs_review, archived left out", async (t) => {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "a-pi", name: "pi agent" }, { id: "rev-pi", kind: "agentic", body: { instructions: "x" } });
  await store.agents.create({ id: "a-cc", name: "cc agent" }, { id: "rev-cc", kind: "agentic", body: { instructions: "x", harness: "claude-code" } });
  await store.agents.create({ id: "a-wf", name: "wf agent" }, { id: "rev-wf", kind: "workflow", body: { workflow: {} } });

  clock.now = T0;
  await store.runs.create({ id: "r-pi", agentId: "a-pi", revisionId: "rev-pi" });
  clock.now = T0 + DAY;
  await store.runs.create({ id: "r-cc", agentId: "a-cc", revisionId: "rev-cc" });
  clock.now = T0 + 2 * DAY;
  await store.runs.create({ id: "r-wf", agentId: "a-wf", revisionId: "rev-wf" });
  await store.runs.create({ id: "r-arch", agentId: "a-pi", revisionId: "rev-pi" });

  await end(store, "r-pi", { state: "ended", outcome: "completed", costUsd: 1, metrics: metrics({ effort: "medium" }), endedAt: T0 });
  await end(store, "r-cc", { state: "ended", outcome: "escalated", costUsd: 2, metrics: metrics({ effort: "low" }), endedAt: T0 + DAY });
  await end(store, "r-wf", { state: "ended", outcome: "completed", costUsd: 3, metrics: metrics({ effort: "high" }), endedAt: T0 + 2 * DAY });
  await end(store, "r-arch", { state: "ended", outcome: "completed", costUsd: 9, metrics: metrics(), endedAt: T0 });
  await store.runs.archive("r-arch", true);

  const a = await analytics(store);
  assert.equal(a.totals.runs, 3, "the archived run is left out");
  assert.equal(a.totals.completed, 3, "two completions and the escalation (escalated counts as completed)");
  assert.equal(a.totals.needsReview, 1, "the escalation");
  assert.deepEqual(a.byHarnessEffort.map((g) => [g.harness, g.effort, g.runs]), [["claude-code", "low", 1], ["pi", "medium", 1], ["workflow", "high", 1]], "by harness then effort");

  // from/to selects by the day a run started, and agent narrows to one.
  assert.deepEqual((await analytics(store, { from: "2026-11-09T05:00:00Z", to: "2026-11-10T05:00:00Z" })).byDay.map((d) => d.day), ["2026-11-09"], "only the middle day's run");
  assert.deepEqual((await analytics(store, { agent: "a-wf" })).totals.runs, 1, "only a-wf's run");
});
