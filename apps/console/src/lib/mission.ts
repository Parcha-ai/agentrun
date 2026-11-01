import { cost } from "./format";
import type { Run } from "./v2";

/** What Mission Control shows: counts from the server's store, the cost said with its basis, and the latest runs. */
export type MissionView = {
  agents: number;
  /** `statusUnknown`: running runs whose state the server can't tell without reading their files, in no other count. */
  runs: { total: number; active: number; needsInput: number; failed: number; statusUnknown: number };
  perAgent: { agentId: string; name: string; runs: number }[];
  /** `usd` sums the runs whose cost is known; `unknownRuns` counts the rest. No known cost at all is null, never 0. */
  cost: { usd: number | null; basis: "reported" | "estimate" | null; unknownRuns: number };
  recent: Run[];
  /** The runs' tokens, time, tools and success over the range the page asked for: null from a server that has none. */
  analytics?: Analytics | null;
};

/** The total cost, said honestly: "Unknown" with no known cost, "est." unless it was charged, and how many runs the
 *  total leaves out. */
export function costLine(c: MissionView["cost"]): string {
  const { total, note } = costParts(c);
  return note ? `${total} · ${note}` : total;
}

/** The total and, apart, how many runs it leaves out: the page shows the note small under the total. */
export function costParts(c: MissionView["cost"]): { total: string; note?: string } {
  if (c.usd === null) return { total: "Unknown" };
  const total = cost({ usd: c.usd, basis: c.basis === "reported" ? "reported" : "estimate", charge_state: null, cap_usd: null });
  return c.unknownRuns ? { total, note: `${c.unknownRuns} ${c.unknownRuns === 1 ? "run" : "runs"} unknown` } : { total };
}

/** `GET /v2/stats` (a serve extension): counts and sums from the agent store, archived agents and runs left out of
 *  every number but `archived`. */
export type Stats = {
  agents: number;
  runs: { total: number; active: number; needs_input: number; failed: number; status_unknown: number };
  per_agent: { agent_id: string; name: string; runs: number }[];
  /** `basis` is the contract's Cost.basis: "charge" or "estimate" (serve says estimate), null when `usd` is null. */
  cost: { usd: number | null; basis: "charge" | "estimate" | null; unknown_runs: number };
  archived?: { agents: number; runs: number };
  /** A newer server's: over the runs `from`, `to` and `agent` pick (every other number is the whole store's). */
  analytics?: Analytics;
};

/** Runs counted together in `analytics`. `failed` takes escalated runs too; `tokens` sums over `runs_with_metrics`
 *  alone; `cost_usd` is null when no run's cost is known, and `unknown_cost_runs` counts the runs it leaves out. */
export type AnalyticsGroup = { runs: number; completed: number; failed: number; runs_with_metrics: number; tokens: number; cost_usd: number | null; unknown_cost_runs: number };
/** GET /v2/stats's `analytics`. `input` excludes cached input: the whole input is input + cache_read + cache_write. */
export type Analytics = {
  filter: { from: string | null; to: string | null; agent: string | null };
  totals: AnalyticsGroup & { input: number; cache_read: number; cache_write: number; output: number; requests: number; unmetered: number };
  time: { ended_runs: number; wall_ms: number; active_runs: number; active_ms: number };
  by_harness_effort: (AnalyticsGroup & { harness: string; effort: string | null })[];
  by_day: (AnalyticsGroup & { day: string })[];
  by_source: (AnalyticsGroup & { source: string })[];
  tools: { tool: string; calls: number; errors: number }[];
};

/** The range Mission Control's analytics cover: the last 7 or 30 UTC days, today included, or every run. */
export type StatsRange = "7d" | "30d" | "all";
export const RANGES: { id: StatsRange; label: string; days: number | null }[] = [{ id: "7d", label: "7 days", days: 7 }, { id: "30d", label: "30 days", days: 30 }, { id: "all", label: "All", days: null }];
const DAY = 86_400_000;
const utcDay = (ms: number) => Math.floor(ms / DAY) * DAY;
/** The `from` a range sends: the start of the UTC day `days - 1` before today, so "7 days" is today and the six before. */
export function rangeFrom(range: StatsRange, now = Date.now()): string | undefined {
  const days = RANGES.find((r) => r.id === range)?.days;
  return days ? new Date(utcDay(now) - (days - 1) * DAY).toISOString() : undefined;
}

/** completed / (completed + failed), or null when no run ended either way. */
export const successRate = (g: Pick<AnalyticsGroup, "completed" | "failed">) => (g.completed + g.failed ? g.completed / (g.completed + g.failed) : null);
/** The share of the whole input that was read from the cache, or null with no input at all. */
export function cachedShare(t: Analytics["totals"]): number | null {
  const input = t.input + t.cache_read + t.cache_write;
  return input ? t.cache_read / input : null;
}
/** A group's cost with the store's basis (the page's), said as costParts says it: never $0 for a cost not known. */
export const groupCost = (g: AnalyticsGroup, basis: MissionView["cost"]["basis"]) => costParts({ usd: g.cost_usd, basis, unknownRuns: g.unknown_cost_runs });
/** What a token sum leaves out, said so a partial figure never reads as complete: "tokens from 3 of 5 runs". */
export const coverage = (g: Pick<AnalyticsGroup, "runs" | "runs_with_metrics">) => (g.runs_with_metrics < g.runs ? `tokens from ${g.runs_with_metrics} of ${g.runs} runs` : undefined);

/** 1,284 / 12.9K / 4.2M. */
export function compact(n: number): string {
  if (n < 10_000) return n.toLocaleString("en-US");
  const [v, unit] = n < 1e6 ? [n / 1e3, "K"] : n < 1e9 ? [n / 1e6, "M"] : [n / 1e9, "B"];
  return `${v < 100 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}${unit}`;
}
export const percent = (share: number | null) => (share === null ? "—" : `${Math.round(share * 100)}%`);
/** A time as hours (one decimal), or minutes or seconds under an hour. */
export function duration(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1).replace(/\.0$/, "")} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** The days the trend draws: from the range's first day (at most 30 days back) to today, in order, a day with no run an
 *  empty group. None when the range holds no run. */
export function trendDays(byDay: Analytics["by_day"], from: string | null, now = Date.now()): Analytics["by_day"] {
  if (!byDay.length) return [];
  const today = utcDay(now);
  const first = Math.max(today - 29 * DAY, from ? utcDay(Date.parse(from)) : today - 29 * DAY);
  const known = new Map(byDay.map((d) => [d.day, d]));
  const out: Analytics["by_day"] = [];
  for (let at = first; at <= today; at += DAY) {
    const day = new Date(at).toISOString().slice(0, 10);
    out.push(known.get(day) ?? { day, runs: 0, completed: 0, failed: 0, runs_with_metrics: 0, tokens: 0, cost_usd: null, unknown_cost_runs: 0 });
  }
  return out;
}

/** The page's view of the server's stats and its latest runs. */
export function missionFrom(s: Stats, recent: Run[]): MissionView {
  return {
    agents: s.agents,
    runs: { total: s.runs.total, active: s.runs.active, needsInput: s.runs.needs_input, failed: s.runs.failed, statusUnknown: s.runs.status_unknown },
    perAgent: s.per_agent.map((a) => ({ agentId: a.agent_id, name: a.name, runs: a.runs })),
    cost: { usd: s.cost.usd, basis: s.cost.basis === "charge" ? "reported" : s.cost.basis, unknownRuns: s.cost.unknown_runs },
    recent,
    ...(s.analytics ? { analytics: s.analytics } : {}),
  };
}
