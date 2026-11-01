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

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;
/** The UTC time an RFC 3339 date-time names, to the millisecond, or undefined for anything else: an impossible date or
 *  time, which Date.parse would roll forward (02-30 to 03-02), and a finer fraction, which it would cut (a bound of
 *  .0005 would read .000), included. */
function utcOf(text: string): string | undefined {
  const m = DATE_TIME.exec(text.toUpperCase());
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return undefined;
  if (m[9] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return undefined;
  const at = Date.parse(text.toUpperCase());
  const iso = Number.isFinite(at) ? new Date(at).toISOString() : "";
  return /^\d{4}-/.test(iso) ? iso : undefined;
}

/** The query's `from` and `to` (RFC 3339 date-times) and `agent` (an agent id): 400 for one that is not. Each absent is
 *  no bound. */
export function analyticsFilter(url: URL): AnalyticsFilter {
  const filter: AnalyticsFilter = {};
  for (const key of ["from", "to"] as const) {
    const text = url.searchParams.get(key);
    if (text === null) continue;
    const iso = utcOf(text);
    if (iso === undefined) throw new ApiError("bad_request", "from and to are RFC 3339 date-times that exist, to the millisecond");
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
