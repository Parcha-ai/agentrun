// GET /v2/stats' counts and cost sums over the one store (design 2.1): the same answers the old store gave, from A's run
// rows, their agents and (for analytics) each run's metrics as the end commit wrote them (the StoredMetrics JSON on the
// row) and its revision's harness. Nothing under a run's journal is read: the figures are the row's, so a run's cost and
// tokens are what its end carried back, never recomputed here. Every number but archivedAgents and archivedRuns leaves
// out what is archived; a run's archive is its own or its agent's.
import type { RunRow, Store } from "../store/store.js";
import { runReadState, type RunReadState } from "./runs.js";

/** The run states the stats count by, as the old store named them. */
export type RunState = RunReadState;
const RUN_STATES: readonly RunState[] = ["running", "completed", "failed", "stopped", "escalated"];
export type RunCounts = Record<RunState, number> & { total: number };
/** `usd` sums the `known` runs' costs (those that ended with one); null when there are none, never 0. A run still running,
 *  or one that ended with no cost, is `unknown`. */
export type CostSum = { usd: number | null; known: number; unknown: number };
export type StoreStats = {
  agents: number;
  archivedAgents: number;
  runs: RunCounts;
  archivedRuns: number;
  cost: CostSum;
  byAgent: Array<{ id: string; name: string; runs: number }>;
  running: string[];
};

const emptyCounts = (): RunCounts => ({ total: 0, running: 0, completed: 0, failed: 0, stopped: 0, escalated: 0 });

/** Every agent, by name then id (the old order), with its archive and name. */
async function allAgents(store: Store): Promise<Array<{ id: string; name: string; archived: boolean }>> {
  const [live, archived] = await Promise.all([store.agents.list({ archived: false }), store.agents.list({ archived: true })]);
  return [...live.map((a) => ({ id: a.id, name: a.name, archived: false })), ...archived.map((a) => ({ id: a.id, name: a.name, archived: true }))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The store's counts and cost sums (the old AgentStoreReader.stats), from A's run rows and agents: one pass over the
 *  runs, grouped by agent and the run's own archive, then folded in with each agent's own archive. */
export async function stats(store: Store): Promise<StoreStats> {
  const agents = await allAgents(store);
  const archivedAgent = new Set(agents.filter((a) => a.archived).map((a) => a.id));
  const runs = await store.runs.list({});

  // Per agent, the runs whose own archive is null (shown) and the count whose own archive is set (hidden).
  const shown = new Map<string, { counts: RunCounts; costUsd: number; known: number }>();
  const hidden = new Map<string, number>();
  const running: string[] = [];
  for (const run of runs) {
    const state = runReadState(run);
    const runArchived = run.archivedAt !== null;
    if (state === "running" && !runArchived && !archivedAgent.has(run.agentId)) running.push(run.id);
    if (runArchived) {
      hidden.set(run.agentId, (hidden.get(run.agentId) ?? 0) + 1);
      continue;
    }
    let g = shown.get(run.agentId);
    if (g === undefined) shown.set(run.agentId, (g = { counts: emptyCounts(), costUsd: 0, known: 0 }));
    g.counts.total += 1;
    g.counts[state] += 1;
    if (state !== "running" && run.costUsd !== null) {
      g.costUsd += run.costUsd;
      g.known += 1;
    }
  }

  const stats: StoreStats = { agents: 0, archivedAgents: 0, runs: emptyCounts(), archivedRuns: 0, cost: { usd: null, known: 0, unknown: 0 }, byAgent: [], running };
  for (const agent of agents) {
    const g = shown.get(agent.id);
    const counts = g?.counts ?? emptyCounts();
    stats.archivedRuns += hidden.get(agent.id) ?? 0;
    if (agent.archived) {
      stats.archivedAgents += 1;
      stats.archivedRuns += counts.total;
      continue;
    }
    stats.agents += 1;
    stats.byAgent.push({ id: agent.id, name: agent.name, runs: counts.total });
    for (const key of ["total", ...RUN_STATES] as const) stats.runs[key] += counts[key];
    const known = g?.known ?? 0;
    if (known > 0) stats.cost.usd = (stats.cost.usd ?? 0) + (g?.costUsd ?? 0);
    stats.cost.known += known;
    stats.cost.unknown += counts.total - known;
  }
  return stats;
}
