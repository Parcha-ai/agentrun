import { costParts } from "./mission";

/** Runs counted together in `GET /v2/stats`'s `analytics` (serve's `stats/2`): `tokens` sums input, cache read, cache
 *  write and output over the `runs_with_metrics`; `cost_usd` is null when no run's cost is known, never 0. */
export type AnalyticsGroup = { runs: number; completed: number; failed: number; runs_with_metrics: number; tokens: number; cost_usd: number | null; unknown_cost_runs: number };
/** `GET /v2/stats`'s `analytics`, over the runs its `from`, `to` and `agent` pick. An older server answers none. */
export type Analytics = {
  filter: { from: string | null; to: string | null; agent: string | null };
  totals: AnalyticsGroup & { input: number; cache_read: number; cache_write: number; output: number; requests: number; unmetered: number };
  time: { ended_runs: number; wall_ms: number; active_runs: number; active_ms: number };
  by_harness_effort: (AnalyticsGroup & { harness: string; effort: string | null })[];
  by_day: (AnalyticsGroup & { day: string })[];
  by_source: (AnalyticsGroup & { source: string })[];
  tools: { tool: string; calls: number; errors: number }[];
};

const DAY_MS = 86_400_000;

/** A count, short: 820, 12.4K, 3.1M. */
export const count = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** A share of a whole as a whole percent; a share above 0 that rounds to 0 reads "<1%". Null when the whole is 0. */
export function share(part: number, whole: number): string | null {
  if (!whole) return null;
  const p = Math.round((100 * part) / whole);
  return p === 0 && part > 0 ? "<1%" : `${p}%`;
}

/** A duration in hours, the unit the tab reads time in; under six minutes, in minutes or seconds. */
export function hours(ms: number): string {
  if (ms >= 360_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** Success: the completed runs of those that completed or failed (a stopped or running run is neither). Null with none. */
export const success = (g: AnalyticsGroup) => share(g.completed, g.completed + g.failed);

/** The cached share of the whole input (input, cache read and cache write): null with no input counted. */
export const cachedShare = (t: Analytics["totals"]) => share(t.cache_read, t.input + t.cache_read + t.cache_write);

/** A group's cost as Mission Control says one: "Unknown" when none is known, never $0, and how many runs it leaves out. */
export const groupCost = (g: AnalyticsGroup) => costParts({ usd: g.cost_usd, basis: g.cost_usd === null ? null : "estimate", unknownRuns: g.unknown_cost_runs });

/** Said when some runs have no metrics: their tokens are in no sum, never read as 0. */
export function coverageNote(t: AnalyticsGroup): string | null {
  const missing = t.runs - t.runs_with_metrics;
  if (missing <= 0) return null;
  return t.runs_with_metrics === 0
    ? `No run here has metrics yet (${t.runs} ${t.runs === 1 ? "run" : "runs"}): token counts are unknown, not zero.`
    : `Tokens come from ${t.runs_with_metrics} of ${t.runs} runs: ${missing} ${missing === 1 ? "has" : "have"} no metrics (running, or ended without them) and ${missing === 1 ? "is" : "are"} in no token count.`;
}

/** Said when some requests' tokens are unknown: they are counted as requests, and in no token sum. */
export function unmeteredNote(t: Analytics["totals"]): string | null {
  if (!t.unmetered) return null;
  return `${t.unmetered} of ${t.requests} model ${t.requests === 1 ? "request" : "requests"} reported no token counts (cut before the end, or not measured): ${t.unmetered === 1 ? "it is" : "they are"} in no token count.`;
}

/** The start of the UTC day `days - 1` days before `now`'s: a range of `days` whole UTC days, today included, as `from`. */
export const fromDays = (days: number, now: number) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (days - 1))).toISOString();
};

/** The last `days` UTC days up to `now`'s, oldest first, each with its group from `byDay` (a day with no run, zeros). */
export function lastDays(byDay: Analytics["by_day"], days: number, now: number): (AnalyticsGroup & { day: string })[] {
  const of = new Map(byDay.map((d) => [d.day, d]));
  const start = Date.parse(fromDays(days, now));
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    return of.get(day) ?? { day, runs: 0, completed: 0, failed: 0, runs_with_metrics: 0, tokens: 0, cost_usd: null, unknown_cost_runs: 0 };
  });
}
