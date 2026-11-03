import { cost, upTo } from "./format";
import type { Run } from "./v2";

/** What Mission Control shows: counts from the server's store, the cost said with its basis, and the latest runs. */
export type MissionView = {
  agents: number;
  /** `statusUnknown`: running runs whose state the server can't tell without reading their files, in no other count.
   *  `needsReview`: escalated runs that completed and wait for a person, apart from `failed`. */
  runs: { total: number; active: number; needsInput: number; failed: number; statusUnknown: number; needsReview: number };
  perAgent: { agentId: string; name: string; runs: number }[];
  /** `usd` sums the runs whose cost is known; `unknownRuns` counts the rest. No known cost at all is null, never 0.
   *  `bounded`: of those unknown, the runs whose cost bound the server knows (requests cut or stopped), and their bounds
   *  summed, which the total never adds in. */
  cost: { usd: number | null; basis: "reported" | "estimate" | null; unknownRuns: number; bounded?: Bounded };
  recent: Run[];
  /** The runs' tokens, time, tools and success over the range the page asked for. */
  analytics: Analytics;
};

/** Runs whose cost is unknown but bounded, and the most they can have cost together (null when no bound is known):
 *  `/v2/stats`' `bounded_unknown`, read. The server sends it from the runs' cost bounds. */
export type Bounded = { runs: number; atMostUsd: number | null };
const boundedOf = (b: { runs: number; at_most_usd: number | null } | undefined): Bounded | undefined => (b ? { runs: b.runs, atMostUsd: b.at_most_usd } : undefined);

/** The total cost, as far as it is known: "Unknown" with no known cost, "est." unless it was charged, how many runs the total
 *  leaves out, and the most its cut runs can add. */
export function costLine(c: MissionView["cost"]): string {
  const { total, note, bound } = costParts(c);
  return [total, note, bound].filter(Boolean).join(" · ");
}

/** The total and, apart, how many runs it leaves out and the most the runs whose requests were cut can add: the page
 *  shows each small under the total. The total stays the known sum, never the known sum plus the bound. */
export function costParts(c: MissionView["cost"]): { total: string; note?: string; bound?: string } {
  const b = c.bounded;
  const bound = b && b.runs > 0 && b.atMostUsd !== null ? `up to ${upTo(b.atMostUsd)}${c.usd === null ? "" : " more"} for ${b.runs} cut ${b.runs === 1 ? "run" : "runs"}` : undefined;
  if (c.usd === null) return { total: "Unknown", ...(bound ? { bound } : {}) };
  const total = cost({ usd: c.usd, basis: c.basis === "reported" ? "reported" : "estimate", charge_state: null, cap_usd: null });
  return { total, ...(c.unknownRuns ? { note: `${c.unknownRuns} ${c.unknownRuns === 1 ? "run" : "runs"} unknown` } : {}), ...(bound ? { bound } : {}) };
}

/** `GET /v2/stats` (a serve extension): counts and sums from the agent store, archived agents and runs left out of
 *  every number but `archived`. */
export type Stats = {
  agents: number;
  runs: { total: number; active: number; needs_input: number; failed: number; status_unknown: number; needs_review: number };
  per_agent: { agent_id: string; name: string; runs: number }[];
  /** `basis` is the contract's Cost.basis: "charge" or "estimate" (serve says estimate), null when `usd` is null. */
  cost: { usd: number | null; basis: "charge" | "estimate" | null; unknown_runs: number; bounded_unknown?: { runs: number; at_most_usd: number | null } };
  archived?: { agents: number; runs: number };
  /** Over the runs `from`, `to` and `agent` pick (every other number is the whole store's). */
  analytics: Analytics;
};

/** Runs counted together in `analytics`. Escalated runs count in `completed`, and `needs_review` says how many.
 *  `tokens` sums over `runs_with_metrics` alone; `cost_usd` is null when no run's cost is known, and
 *  `unknown_cost_runs` counts the runs it leaves out. */
export type AnalyticsGroup = { runs: number; completed: number; failed: number; needs_review: number; runs_with_metrics: number; tokens: number; cost_usd: number | null; unknown_cost_runs: number };
/** GET /v2/stats's `analytics`. `input` excludes cached input: the whole input is input + cache_read + cache_write. */
export type Analytics = {
  filter: { from: string | null; to: string | null; agent: string | null };
  totals: AnalyticsGroup & { input: number; cache_read: number; cache_write: number; output: number; requests: number; unmetered: number; bounded_unknown?: { runs: number; at_most_usd: number | null } };
  time: { ended_runs: number; wall_ms: number; active_runs: number; active_ms: number };
  by_harness_effort: (AnalyticsGroup & { harness: string; effort: string | null })[];
  by_day: (AnalyticsGroup & { day: string })[];
  by_source: (AnalyticsGroup & { source: string })[];
  /** `label`: what a person calls the tool (the server's label registry). */
  tools: { tool: string; label: string; calls: number; errors: number }[];
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

/** The runs that ended accepted over those that ended, or null when none did. A run that waits for review is no
 *  success: it counts in `completed`, and `needs_review` says so. */
export const successRate = (g: Pick<AnalyticsGroup, "completed" | "failed" | "needs_review">) => (g.completed + g.failed ? (g.completed - g.needs_review) / (g.completed + g.failed) : null);

/** How the runs that ended split: "9 completed · 2 failed · 1 needs review". */
export function outcomes(g: Pick<AnalyticsGroup, "completed" | "failed" | "needs_review">): string {
  return [`${g.completed - g.needs_review} completed`, `${g.failed} failed`, g.needs_review ? `${g.needs_review} ${g.needs_review === 1 ? "needs" : "need"} review` : ""].filter(Boolean).join(" · ");
}
/** The share of the whole input that was read from the cache, or null with no input at all. */
export function cachedShare(t: Analytics["totals"]): number | null {
  const input = t.input + t.cache_read + t.cache_write;
  return input ? t.cache_read / input : null;
}
/** A group's cost with the store's basis (the page's), said as costParts says it: never $0 for a cost not known. */
export const groupCost = (g: AnalyticsGroup & { bounded_unknown?: { runs: number; at_most_usd: number | null } }, basis: MissionView["cost"]["basis"]) =>
  costParts({ usd: g.cost_usd, basis, unknownRuns: g.unknown_cost_runs, ...(g.bounded_unknown ? { bounded: boundedOf(g.bounded_unknown) } : {}) });
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
    out.push(known.get(day) ?? { day, runs: 0, completed: 0, failed: 0, needs_review: 0, runs_with_metrics: 0, tokens: 0, cost_usd: null, unknown_cost_runs: 0 });
  }
  return out;
}

/** The page's view of the server's stats and its latest runs. */
export function missionFrom(s: Stats, recent: Run[]): MissionView {
  return {
    agents: s.agents,
    runs: { total: s.runs.total, active: s.runs.active, needsInput: s.runs.needs_input, failed: s.runs.failed, statusUnknown: s.runs.status_unknown, needsReview: s.runs.needs_review },
    perAgent: s.per_agent.map((a) => ({ agentId: a.agent_id, name: a.name, runs: a.runs })),
    cost: { usd: s.cost.usd, basis: s.cost.basis === "charge" ? "reported" : s.cost.basis, unknownRuns: s.cost.unknown_runs, ...(s.cost.bounded_unknown ? { bounded: boundedOf(s.cost.bounded_unknown) } : {}) },
    recent,
    analytics: s.analytics,
  };
}
