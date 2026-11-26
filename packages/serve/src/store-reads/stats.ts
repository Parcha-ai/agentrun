// GET /v2/stats' counts and cost sums over the one store (design 2.1): the same answers the old store gave, from A's run
// rows, their agents and (for analytics) each run's metrics as the end commit wrote them (the StoredMetrics JSON on the
// row) and its revision's harness. Nothing under a run's journal is read: the figures are the row's, so a run's cost and
// tokens are what its end carried back, never recomputed here. Every number but archivedAgents and archivedRuns leaves
// out what is archived; a run's archive is its own or its agent's.
import type { Store } from "../store/store.js";
import { costOfRun, runReadState, type RunReadState } from "./runs.js";
import { isShadowRun, shadowRunId } from "../learn/audit.js";
import { shadowOfRun, shadowUsdOf } from "../learn/ledger.js";
import { type CostBasis, joinedBasis, storedBasisOf } from "../runner/metrics.js";

/** The run states the stats count by, as the old store named them. */
export type RunState = RunReadState;
const RUN_STATES: readonly RunState[] = ["running", "completed", "failed", "stopped", "escalated"];
export type RunCounts = Record<RunState, number> & { total: number };
/** `usd` sums the costs of the runs that ended with one and their shadows' known costs; null when there are none, never
 *  0. A run still running, one that ended with no cost, or one whose shadow is at work or unpriced, is `unknown`. `basis`: how the summed costs were reached (metrics.ts joinedBasis over
 *  each one's stored basis, storedBasisOf). */
export type CostSum = { usd: number | null; known: number; unknown: number; basis: CostBasis };
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
  // A purged agent (an archived one's tombstone) still counts, as its runs' cost does.
  const [live, archived] = await Promise.all([store.agents.list({ archived: false, purged: true }), store.agents.list({ archived: true, purged: true })]);
  return [...live.map((a) => ({ id: a.id, name: a.name, archived: false })), ...archived.map((a) => ({ id: a.id, name: a.name, archived: true }))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The store's counts and cost sums (the old AgentStoreReader.stats), from A's run rows and agents: one pass over the
 *  runs, grouped by agent and the run's own archive, then folded in with each agent's own archive. */
export async function stats(store: Store): Promise<StoreStats> {
  const agents = await allAgents(store);
  const archivedAgent = new Set(agents.filter((a) => a.archived).map((a) => a.id));
  // A purged run's tombstone keeps its state and cost: every count and sum reads it as before its purge.
  const runs = await store.runs.list({ purged: true });

  // Per agent, the runs whose own archive is null (shown) and the count whose own archive is set (hidden).
  const shown = new Map<string, { counts: RunCounts; costUsd: number; priced: number; known: number; shadowUsd: number; bases: CostBasis[] }>();
  const hidden = new Map<string, number>();
  const running: string[] = [];
  // Each revision's kind, read once: an agentic run a person stopped reads running (runReadState).
  const kinds = new Map<string, "agentic" | "workflow">();
  // An audit's shadow run is learning spend on the run it audits, never a run of its own (A8): its cost, once known, is
  // in the dollars with that run, shown or hidden with it; it is in no count, and never running work.
  const shadows = new Map(runs.filter((run) => isShadowRun(run.id)).map((run) => [run.id, run]));
  for (const run of runs) {
    if (isShadowRun(run.id)) continue;
    if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind === "workflow" ? "workflow" : "agentic");
    const state = runReadState(run, kinds.get(run.revisionId)!);
    const runArchived = run.archivedAt !== null;
    if (state === "running" && !runArchived && !archivedAgent.has(run.agentId)) running.push(run.id);
    if (runArchived) {
      hidden.set(run.agentId, (hidden.get(run.agentId) ?? 0) + 1);
      continue;
    }
    let g = shown.get(run.agentId);
    if (g === undefined) shown.set(run.agentId, (g = { counts: emptyCounts(), costUsd: 0, priced: 0, known: 0, shadowUsd: 0, bases: [] }));
    const shadow = shadows.get(shadowRunId(run.id));
    // Its shadow's cost as the ledger reads it (shadowUsdOf): unknown while at work or unpriced, never $0.
    const shadowUsd = shadowUsdOf(shadow && shadowOfRun(shadow));
    if (shadow && shadowUsd !== null) {
      g.shadowUsd += shadowUsd;
      g.bases.push(storedBasisOf(shadow.metrics, shadowUsd));
    }
    g.counts.total += 1;
    g.counts[state] += 1;
    // Its cost as its read says it (costOfRun): an imported session's catalog estimate when its source priced none. Its
    // $ is spent either way; the run is known only with its shadow's.
    const cost = costOfRun(run);
    if (state !== "running" && cost !== null) {
      g.costUsd += cost;
      g.priced += 1;
      if (shadowUsd !== null) g.known += 1;
      g.bases.push(storedBasisOf(run.metrics, cost));
    }
  }

  const stats: StoreStats = { agents: 0, archivedAgents: 0, runs: emptyCounts(), archivedRuns: 0, cost: { usd: null, known: 0, unknown: 0, basis: "unpriced" }, byAgent: [], running };
  const bases: CostBasis[] = [];
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
    // A shadow's known $ is spent whether or not the run it audits has a known cost: never a null for its dollars.
    if ((g?.priced ?? 0) > 0 || (g?.shadowUsd ?? 0) > 0) stats.cost.usd = (stats.cost.usd ?? 0) + (g?.costUsd ?? 0) + (g?.shadowUsd ?? 0);
    stats.cost.known += known;
    stats.cost.unknown += counts.total - known;
    bases.push(...(g?.bases ?? []));
  }
  stats.cost.basis = joinedBasis(bases);
  return stats;
}
