// Two to four runs' traces side by side (#/compare?runs=…): the figures the Dev tools tab says of one run, one column a
// run, for a person who asks what a change did (another model, another harness, a new revision, a race's lanes). Every
// figure is one the tab itself shows of that run (lib/trace); a figure a run's trace does not carry stays unknown (null),
// never 0, and no difference is said of it. Nor of a figure that is not exact: a sum over the part of a run its trace
// holds, or a ceiling.
import { runEnded } from "./format";
import { soFar } from "./format";
import { byModel, byTool, cacheShare, duration, inputTokens, percent, spanMs, traceTotals, usd } from "./trace";
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

/** A run's id out of what a person pasted: the id itself, or a run page's address (`…#/runs/<id>`). Null for neither,
 *  and for an address whose id is no valid escape (`#/runs/%`), which is refused in words like any other. */
export function runIdOf(pasted: string): string | null {
  const text = pasted.trim();
  const linked = text.match(/#\/runs\/([^/?#\s]+)/);
  if (linked) { try { return decodeURIComponent(linked[1]!); } catch { return null; } }
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text) ? text : null;
}

/** One run compared: the run, its trace, and the moment its spans still going are drawn to (its end once it ended). */
export type Side = { run: Run; trace: RunTrace; now: number };
export const sideOf = (run: Run, trace: RunTrace, clock: number): Side => ({ run, trace, now: runEnded(run.status) && run.ended_at ? Date.parse(run.ended_at) : clock });

/** Whether a run's trace is only its first spans (a read serves 2,000 and counts the rest in `dropped`): every figure
 *  summed from it is then of that part, at least what the whole run's is. */
export const partial = (side: Pick<Side, "trace">) => side.trace.dropped > 0;

/** One run's value of a figure: the number (null where its trace or its record carries none), its words, and whether it
 *  is exact. Not exact: a sum over a part of the run ("at least", a trace cut at its first spans, tokens where some
 *  requests reported none, a time where a span's length is not kept, or a cost where a charge has no price), a share
 *  of such a part ("partial"), or a ceiling ("at most", a cost that counts a cut request at what was held for it). A
 *  difference is said only of two exact values. */
export type Cell = { value: number | null; words: string; exact: boolean };
/** One figure across the runs: its name, each run's cell, and how a difference of it is said. */
export type FigureRow = { label: string; cells: Cell[]; say: (n: number) => string; share?: true };

/** The figures the Dev tools tab's tiles say of a run, across `sides`. */
export function compareFigures(sides: readonly Side[]): FigureRow[] {
  const totals = sides.map((side) => traceTotals(side.trace, side.now));
  const count = (n: number) => n.toLocaleString("en-US");
  /** A sum from the trace: at least that, where the trace is a part of the run or `short` says the sum left some out. */
  const sum = (say: (n: number) => string, of: (i: number) => number | null, short: (i: number) => boolean = () => false) => sides.map((side, i): Cell => {
    const value = of(i);
    const least = partial(side) || short(i);
    return { value, words: value === null ? "–" : `${least ? "at least " : ""}${say(value)}`, exact: value !== null && !least };
  });
  const recorded = (i: number) => sides[i]!.trace.model_requests !== "not_recorded";
  /** A run's requests' tokens: none where its record keeps no request, or where no request reported any. */
  const told = (i: number) => (recorded(i) && totals[i]!.tokens && totals[i]!.untold < totals[i]!.requests ? totals[i]!.tokens : null);
  // A span whose length the trace does not keep (a request with no duration recorded, a call cut with no result) adds no
  // time to any sum, though it took some: a time summed over such spans is at least what is said, and unknown where no
  // span of its kind has a length. A model request with no length may also have answered while a tool ran, time the
  // sum then counts as the tool's alone: the tools' time is then neither a floor nor a ceiling, and is said as partial.
  const untimed = sides.map((side) => {
    const none = (kind: "model" | "tool") => side.trace.spans.filter((s) => s.kind === kind && spanMs(s, side.now) === null).length;
    const of = (kind: "model" | "tool") => side.trace.spans.filter((s) => s.kind === kind).length;
    return { model: none("model"), tool: none("tool"), models: of("model"), tools: of("tool") };
  });
  const row = (label: string, cells: Cell[], say: (n: number) => string, share?: true): FigureRow => ({ label, cells, say, ...(share ? { share } : {}) });
  return [
    row("Model requests", sum(count, (i) => (recorded(i) ? totals[i]!.requests : null)), count),
    row("Tool calls", sum(count, (i) => totals[i]!.calls), count),
    row("Failed", sum(count, (i) => totals[i]!.failed), count),
    // Requests that reported no tokens (cut before their usage came) are in neither sum: the tokens are at least these.
    row("Tokens", sum(count, (i) => { const t = told(i); return t ? inputTokens(t) + t.output : null; }, (i) => totals[i]!.untold > 0), count),
    row("Input read from cache", sides.map((side, i): Cell => {
      const t = told(i);
      const value = t ? cacheShare(t) : null;
      const part = partial(side) || totals[i]!.untold > 0;
      return { value, words: value === null ? "–" : `${percent(value)}${part ? ", partial" : ""}`, exact: value !== null && !part };
    }), percent, true),
    // The run's own cost, not the trace's: whole whatever the trace holds, and a ceiling where the run's is. Where the
    // server gives no whole cost for a charge with no price, what is priced is said as at least that: the figure the
    // run's own tab says as its cost so far (lib/format soFar).
    row("Cost", sides.map((side): Cell => {
      const cost = side.run.cost;
      const known = soFar(cost);
      if (known) return { value: known.so_far_usd, words: `at least ${usd(known.so_far_usd)}`, exact: false };
      const value = typeof cost?.usd === "number" ? cost.usd : null;
      return { value, words: value === null ? "–" : `${cost?.upper_bound ? "at most " : ""}${usd(value)}`, exact: value !== null && cost?.upper_bound !== true };
    }), usd),
    row("Time", sum(duration, (i) => totals[i]!.time.wall, (i) => untimed[i]!.model + untimed[i]!.tool > 0), duration),
    // A harness whose record keeps no model request has no time of one to say: unknown, never none.
    row("A model answering", sum(duration, (i) => (recorded(i) && !(untimed[i]!.models > 0 && untimed[i]!.model === untimed[i]!.models) ? totals[i]!.time.model : null), (i) => untimed[i]!.model > 0), duration),
    row("A tool running", sides.map((side, i): Cell => {
      const u = untimed[i]!;
      const value = u.tools > 0 && u.tool === u.tools ? null : totals[i]!.time.tools;
      const [least, mixed] = [partial(side) || u.tool > 0, u.model > 0];
      return { value, words: value === null ? "–" : mixed ? `${duration(value)}, partial` : `${least ? "at least " : ""}${duration(value)}`, exact: value !== null && !least && !mixed };
    }), duration),
  ];
}

/** What the second run's figure is against the first's, in words: "Same", "+3 (+38%)", "−$0.0120 (−14%)", and for a
 *  share its points ("+12 points"). Null where either is unknown or not exact (a part of a run, a ceiling): a difference
 *  of such a figure would be said as the runs' own. The percent is of the first run's figure, and is left out where
 *  that is 0. */
export function differenceWords(row: Pick<FigureRow, "cells" | "say" | "share">): string | null {
  const [first, second] = row.cells;
  if (!first || !second || first.value === null || second.value === null || !first.exact || !second.exact) return null;
  const [a, b] = [first.value, second.value];
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
 *  across the runs first. A run that never called a tool has 0 of each for it (of the part its trace holds: the page
 *  says a partial run's as such). */
export type ToolCompare = { name: string; calls: number[]; failed: number[]; ms: number[] };
export function compareTools(sides: readonly Side[]): ToolCompare[] {
  const by = sides.map((side) => new Map(byTool(side.trace.spans, side.now).map((row) => [row.name, row])));
  const names = [...new Set(by.flatMap((rows) => [...rows.keys()]))];
  return names.map((name) => ({ name, calls: by.map((rows) => rows.get(name)?.calls ?? 0), failed: by.map((rows) => rows.get(name)?.failed ?? 0), ms: by.map((rows) => rows.get(name)?.totalMs ?? 0) }))
    .sort((a, b) => b.ms.reduce((sum, n) => sum + n, 0) - a.ms.reduce((sum, n) => sum + n, 0) || (a.name < b.name ? -1 : 1));
}

/** Each model any of the runs sent a request to, with each run's requests, tokens (input and output) and cost. A run
 *  whose record keeps no model request (a CLI harness's) has null for all three: it may have used the model, and its
 *  trace does not say. A cost is null too where the run's requests carry none of their own or one of them is unknown.
 *  The model with the most requests across the runs first. */
export type ModelCompare = { name: string; requests: (number | null)[]; tokens: (number | null)[]; usd: (number | null)[] };
export function compareModels(sides: readonly Side[]): ModelCompare[] {
  const kept = sides.map((side) => side.trace.model_requests !== "not_recorded");
  const by = sides.map((side) => new Map(byModel(side.trace.spans, side.trace.model_requests === "priced").map((row) => [row.name, row])));
  const names = [...new Set(by.flatMap((rows) => [...rows.keys()]))];
  return names.map((name) => ({
    name,
    requests: by.map((rows, i) => (kept[i] ? rows.get(name)?.requests ?? 0 : null)),
    tokens: by.map((rows, i) => { if (!kept[i]) return null; const t = rows.get(name)?.tokens; return t ? inputTokens(t) + t.output : 0; }),
    usd: by.map((rows, i) => { if (!kept[i]) return null; const row = rows.get(name); return !row ? 0 : row.cost && row.cost.unknown === 0 ? row.cost.usd : null; }),
  })).sort((a, b) => b.requests.reduce<number>((sum, n) => sum + (n ?? 0), 0) - a.requests.reduce<number>((sum, n) => sum + (n ?? 0), 0) || (a.name < b.name ? -1 : 1));
}
