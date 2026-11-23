// Two to four runs' traces side by side (#/compare?runs=…): the figures the Dev tools tab says of one run, one column a
// run, for a person who asks what a change did (another model, another harness, a new revision, a race's lanes). Every
// figure is one the tab itself shows of that run (lib/trace); a figure a run's trace does not carry stays unknown (null),
// never 0, and no difference is said of it.
import { runEnded } from "./format";
import { byModel, byTool, cacheShare, duration, inputTokens, percent, traceTotals, usd } from "./trace";
import type { Run, RunTrace } from "./v2";

/** The address's query key for the runs compared, and how many one page compares. */
export const COMPARE_KEY = "runs";
export const MIN_COMPARED = 2;
export const MAX_COMPARED = 4;

/** The address that compares `ids`, in the order given. */
export const compareHref = (ids: readonly string[]) => `#/compare?${COMPARE_KEY}=${ids.map(encodeURIComponent).join(",")}`;

/** The run ids an address's query names: each once, in the order given, at most MAX_COMPARED. */
export function comparedIds(query: string): string[] {
  const named = (new URLSearchParams(query).get(COMPARE_KEY) ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
  return [...new Set(named)].slice(0, MAX_COMPARED);
}

/** A run's id out of what a person pasted: the id itself, or a run page's address (`…#/runs/<id>`). Null for neither. */
export function runIdOf(pasted: string): string | null {
  const text = pasted.trim();
  const linked = text.match(/#\/runs\/([^/?#\s]+)/);
  if (linked) return decodeURIComponent(linked[1]!);
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text) ? text : null;
}

/** One run compared: the run, its trace, and the moment its spans still going are drawn to (its end once it ended). */
export type Side = { run: Run; trace: RunTrace; now: number };
export const sideOf = (run: Run, trace: RunTrace, clock: number): Side => ({ run, trace, now: runEnded(run.status) && run.ended_at ? Date.parse(run.ended_at) : clock });

/** One figure across the runs: its name, each run's value in words ("–" where its trace carries none) and as a number
 *  (null there), and how a difference of it is said. */
export type FigureRow = { label: string; words: string[]; values: (number | null)[]; say: (n: number) => string; share?: true };

/** The figures the Dev tools tab's tiles say of a run, across `sides`. */
export function compareFigures(sides: readonly Side[]): FigureRow[] {
  const totals = sides.map((side) => traceTotals(side.trace, side.now));
  const count = (n: number) => n.toLocaleString("en-US");
  const row = (label: string, values: (number | null)[], say: (n: number) => string, share?: true): FigureRow => ({ label, values, words: values.map((v) => (v === null ? "–" : say(v))), say, ...(share ? { share } : {}) });
  return [
    row("Model requests", sides.map((side, i) => (side.trace.model_requests === "not_recorded" ? null : totals[i]!.requests)), count),
    row("Tool calls", totals.map((t) => t.calls), count),
    row("Failed", totals.map((t) => t.failed), count),
    row("Tokens", totals.map((t) => (t.tokens ? inputTokens(t.tokens) + t.tokens.output : null)), count),
    row("Input read from cache", totals.map((t) => (t.tokens ? cacheShare(t.tokens) : null)), percent, true),
    row("Cost", sides.map((side) => (typeof side.run.cost?.usd === "number" ? side.run.cost.usd : null)), usd),
    row("Time", totals.map((t) => t.time.wall), duration),
    row("A model answering", totals.map((t) => t.time.model), duration),
    row("A tool running", totals.map((t) => t.time.tools), duration),
  ];
}

/** What the second run's figure is against the first's, in words: "Same", "+3 (+38%)", "−$0.0120 (−14%)", and for a
 *  share its points ("+12 points"). Null where either is unknown. The percent is of the first run's figure, and is left
 *  out where that is 0. */
export function differenceWords(row: Pick<FigureRow, "values" | "say" | "share">): string | null {
  const [a, b] = row.values;
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const by = b - a;
  if (Math.abs(by) < 1e-12) return "Same";
  const sign = by > 0 ? "+" : "−";
  if (row.share) {
    const points = Math.round(Math.abs(by) * 100);
    return points === 0 ? "Same" : `${sign}${points} point${points === 1 ? "" : "s"}`;
  }
  return `${sign}${row.say(Math.abs(by))}${a > 0 ? ` (${sign}${Math.round((Math.abs(by) / a) * 100)}%)` : ""}`;
}

/** Each tool any of the runs called, with each run's calls, failures and total time: the tool that took the most time
 *  across the runs first. A run that never called a tool has 0 of each for it. */
export type ToolCompare = { name: string; calls: number[]; failed: number[]; ms: number[] };
export function compareTools(sides: readonly Side[]): ToolCompare[] {
  const by = sides.map((side) => new Map(byTool(side.trace.spans, side.now).map((row) => [row.name, row])));
  const names = [...new Set(by.flatMap((rows) => [...rows.keys()]))];
  return names.map((name) => ({ name, calls: by.map((rows) => rows.get(name)?.calls ?? 0), failed: by.map((rows) => rows.get(name)?.failed ?? 0), ms: by.map((rows) => rows.get(name)?.totalMs ?? 0) }))
    .sort((a, b) => b.ms.reduce((sum, n) => sum + n, 0) - a.ms.reduce((sum, n) => sum + n, 0) || (a.name < b.name ? -1 : 1));
}

/** Each model any of the runs sent a request to, with each run's requests, tokens (input and output) and cost; a cost is
 *  null where the run's requests carry none of their own or one of them is unknown. The model with the most requests
 *  across the runs first. */
export type ModelCompare = { name: string; requests: number[]; tokens: number[]; usd: (number | null)[] };
export function compareModels(sides: readonly Side[]): ModelCompare[] {
  const by = sides.map((side) => new Map(byModel(side.trace.spans, side.trace.model_requests === "priced").map((row) => [row.name, row])));
  const names = [...new Set(by.flatMap((rows) => [...rows.keys()]))];
  return names.map((name) => ({
    name,
    requests: by.map((rows) => rows.get(name)?.requests ?? 0),
    tokens: by.map((rows) => { const t = rows.get(name)?.tokens; return t ? inputTokens(t) + t.output : 0; }),
    usd: by.map((rows) => { const row = rows.get(name); return !row ? 0 : row.cost && row.cost.unknown === 0 ? row.cost.usd : null; }),
  })).sort((a, b) => b.requests.reduce((sum, n) => sum + n, 0) - a.requests.reduce((sum, n) => sum + n, 0) || (a.name < b.name ? -1 : 1));
}
