// GET /v2/stats, this server's own route: the agent store's counts and cost sums (AgentStoreReader.stats, SQL
// aggregates over store.sqlite), with what only the runs this server holds can say. Nothing under runs/ is opened: a
// running run this server does not hold has no status here, and is counted as unknown, never as active or not waiting.
import type { AnalyticsFilter, AnalyticsGroup, StoreAnalytics, StoreStats } from "@parcha/pi-durable-agent";
import { ApiError } from "./errors.js";
import { type Runs, type Status, statusOf } from "./runs.js";
import { ID } from "./validate.js";

type Bucket = "active" | "needs_input" | "status_unknown";
/** Where a running row this server holds is counted, by its status (a paused workflow run is held, so active). One it holds as ended, its end not yet written to
 *  the store, is neither active nor waiting: unknown. */
const BUCKET: Record<Status, Bucket> = { queued: "active", working: "active", paused: "active", input_required: "needs_input", completed: "status_unknown", failed: "status_unknown", cancelled: "status_unknown" };

/** As GET /usage rounds its sums; null stays null. */
const round = (usd: number | null) => (usd === null ? null : Math.round(usd * 1e6) / 1e6);

export function statsView(stats: StoreStats, runs: Runs) {
  const running: Record<Bucket, number> = { active: 0, needs_input: 0, status_unknown: 0 };
  for (const id of stats.running) {
    const run = runs.held(id);
    running[run ? BUCKET[statusOf(run).status] : "status_unknown"] += 1;
  }
  const usd = round(stats.cost.usd);
  return {
    agents: stats.agents,
    runs: { total: stats.runs.total, active: running.active, needs_input: running.needs_input, failed: stats.runs.failed + stats.runs.escalated, status_unknown: running.status_unknown },
    per_agent: stats.byAgent.map((a) => ({ agent_id: a.id, name: a.name, runs: a.runs })),
    cost: { usd, basis: usd === null ? null : "estimate", unknown_runs: stats.cost.unknown },
    archived: { agents: stats.archivedAgents, runs: stats.archivedRuns },
  };
}

// ---- analytics: the runs' metrics summed (AgentStoreReader.analytics), over the runs `from`, `to` and `agent` pick ----

/** The query's `from` and `to` (RFC 3339, read as GET /usage reads them) and `agent` (an agent id): 400 for one that is
 *  not. Each absent is no bound. */
export function analyticsFilter(url: URL): AnalyticsFilter {
  const filter: AnalyticsFilter = {};
  for (const key of ["from", "to"] as const) {
    const text = url.searchParams.get(key);
    if (text === null) continue;
    const at = Date.parse(text);
    const iso = Number.isFinite(at) ? new Date(at).toISOString() : "";
    if (!/^\d{4}-/.test(iso)) throw new ApiError("bad_request", "from and to are RFC 3339 times");
    filter[key] = iso;
  }
  const agent = url.searchParams.get("agent");
  if (agent !== null) {
    if (!ID.test(agent)) throw new ApiError("bad_request", "agent is an agent id");
    filter.agent = agent;
  }
  return filter;
}

const group = (g: AnalyticsGroup) => ({ runs: g.runs, completed: g.completed, failed: g.failed, runs_with_metrics: g.runsWithMetrics, tokens: g.tokens, cost_usd: round(g.costUsd), unknown_cost_runs: g.unknownCostRuns });

export function analyticsView(a: StoreAnalytics, filter: AnalyticsFilter) {
  const t = a.totals;
  return {
    filter: { from: filter.from ?? null, to: filter.to ?? null, agent: filter.agent ?? null },
    totals: { ...group(t), input: t.input, cache_read: t.cacheRead, cache_write: t.cacheWrite, output: t.output, requests: t.requests, unmetered: t.unmetered },
    time: { ended_runs: a.time.endedRuns, wall_ms: a.time.wallMs, active_runs: a.time.activeRuns, active_ms: a.time.activeMs },
    by_harness_effort: a.byHarnessEffort.map((g) => ({ harness: g.harness, effort: g.effort, ...group(g) })),
    by_day: a.byDay.map((g) => ({ day: g.day, ...group(g) })),
    by_source: a.bySource.map((g) => ({ source: g.source, ...group(g) })),
    tools: a.tools,
  };
}
