// The cost per run chart's arithmetic (components/CostPerRun.tsx): which runs it plots, the rolling mean, the y scale
// and where a run's dot goes past the top. The series and what it shows (the takeover, the levels before and after it)
// are the server's (GET /v2/agents/{id}/learning/cost); nothing here says more than the server does.
import type { CostRun, RunPath } from "./v2";

/** The paths in the legend's order, each with its words and its series token (tokens.css --chart-*). */
export const PATHS: readonly { path: RunPath; label: string; fill: string; stroke: string }[] = [
  { path: "agent", label: "By the agent", fill: "fill-chart-agent", stroke: "stroke-chart-agent" },
  { path: "handed_back", label: "Handed back", fill: "fill-chart-handed-back", stroke: "stroke-chart-handed-back" },
  { path: "workflow", label: "Learned workflow", fill: "fill-chart-workflow", stroke: "stroke-chart-workflow" },
  // A replay run: a learned workflow's new revision run alone on a graded input before it serves (its cost is learning's).
  { path: "replay", label: "Replay", fill: "fill-muted-foreground", stroke: "stroke-muted-foreground" },
];
export const pathOf = (path: RunPath) => PATHS.find((p) => p.path === path)!;

/** A run on the chart's run axis, which numbers the runs that do a job (`n`, as the bill does): `at`, where it stands. */
export type Placed = CostRun & { at: number };
/** Each run where it stands on the run axis: a run that does a job at its number; a replay, which does none and has no
 *  number, half a run after the job it followed (before any job read, half a run before the first), so it is drawn
 *  between two jobs and never numbered as one. */
export function placed(runs: readonly CostRun[]): Placed[] {
  const first = runs.find((r) => r.path !== "replay" && r.n !== null)?.n ?? 1;
  let last: number | null = null;
  return runs.map((r) => {
    if (r.path !== "replay" && r.n !== null) { last = r.n; return { ...r, at: r.n }; }
    return { ...r, at: last === null ? first - 0.5 : last + 0.5 };
  });
}

/** A run the chart plots: one whose all-in cost is known, where it stands on the run axis. */
export type Point = Placed & { total_usd: number };
export const plotted = (runs: readonly CostRun[]): Point[] => placed(runs).filter((r): r is Point => r.total_usd !== null);

/** A run that does a job: numbered on the run axis, as the bill numbers it (a replay has no number). */
export type Job = CostRun & { n: number };
export const jobsOf = (runs: readonly CostRun[]): Job[] => runs.filter((r): r is Job => r.path !== "replay" && r.n !== null);

/** The rolling mean's window: about a fifteenth of the runs, from 3 to 25, so a few runs still draw a line and a
 *  thousand do not flatten it to nothing. */
export const windowOf = (count: number) => Math.min(25, Math.max(3, Math.round(count / 15)));

/** The trailing mean of each point's all-in $ over the last `window` points, itself included (fewer at the start). */
export function rollingMean(points: readonly Point[], window: number): number[] {
  const out: number[] = [];
  let sum = 0;
  points.forEach((p, i) => {
    sum += p.total_usd;
    if (i >= window) sum -= points[i - window]!.total_usd;
    out.push(sum / Math.min(i + 1, window));
  });
  return out;
}

/** A clean top for an axis: 1, 2, 2.5 or 5 times a power of ten, at or above `max`. */
export function niceTop(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((v) => v >= max * (1 - 1e-9))!;
}

/** An axis just above `max`: the smallest clean step (1, 2, 2.5 or 5 times a power of ten) that reaches it in five steps
 *  or fewer, its top the step it reaches it at, and its ticks from 0 ($1.18 reads 0 to $1.25 by $0.25, never to $2). */
export function niceAxis(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const p = 10 ** Math.floor(Math.log10(max / 5));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => Math.ceil(max / s - 1e-9) <= 5)!;
  const steps = Math.max(1, Math.ceil(max / step - 1e-9));
  const ticks = Array.from({ length: steps + 1 }, (_, i) => Math.round(i * step * 1e12) / 1e12);
  return { top: ticks.at(-1)!, ticks };
}

/** The y axis' ticks from 0 to `top` (a niceTop): a clean step (1, 2 or 5 times a power of ten, 2.5 for a top of 10), four
 *  or five steps, never a quarter of 5 ($0.00125). */
export function yTicksOf(top: number): number[] {
  const p = 10 ** Math.floor(Math.log10(top) + 1e-9);
  const lead = Math.round((top / p) * 10) / 10;
  const step = ({ 1: 0.25, 2: 0.5, 2.5: 0.5, 5: 1, 10: 2.5 } as Record<number, number>)[lead] ?? top / 4;
  const ticks: number[] = [];
  for (let i = 0; i * step * p <= top * (1 + 1e-9); i++) ticks.push(Math.round(i * step * p * 1e12) / 1e12);
  return ticks;
}

/** The y axis' top: over the 95th percentile of the runs, the rolling mean and the level before learning, so one runaway
 *  run does not squash the rest to the floor. A run above it is drawn at the top, and counted (`above`). */
export function yTopOf(points: readonly Point[], mean: readonly number[], before: number | null): { top: number; above: number } {
  if (!points.length) return { top: 1, above: 0 };
  const sorted = points.map((p) => p.total_usd).sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
  const top = niceTop(Math.max(p95, ...mean, before ?? 0) * 1.08);
  return { top, above: points.filter((p) => p.total_usd > top).length };
}

/** Up to `most` ticks of run numbers from `first` to `last`: whole runs, a clean step. */
export function runTicks(first: number, last: number, most = 6): number[] {
  if (last <= first) return [first];
  const raw = (last - first) / Math.max(1, most - 1);
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((k) => k * p).find((v) => v >= raw)!);
  const ticks: number[] = [];
  for (let t = Math.ceil(first / step) * step; t <= last; t += step) ticks.push(t);
  if (!ticks.includes(first) && (ticks[0] ?? Infinity) - first > step / 2) ticks.unshift(first);
  return ticks;
}

/** The least room between two labels in a chart's gutter: one label's line. */
export const LABEL_GAP = 14;
/** A gutter right of a plot wide enough for `labels` (the charts' 11px mono, 0.6em a character) 6px off the plot, with
 *  room to spare at its right edge: a label never runs past the chart. */
export const gutterFor = (labels: readonly string[]) => Math.ceil(6 + Math.max(0, ...labels.map((l) => l.length)) * 6.6 + 8);
/** Labels at their places down a gutter (`at`, top down), moved apart so each pair is at least LABEL_GAP apart and all
 *  stay within `lo` to `hi`: a close pair moves out from its middle, never past the gutter's ends. In the order given. */
export function spread<L extends { at: number }>(labels: readonly L[], lo: number, hi: number): L[] {
  const moved = labels.map((l) => ({ ...l }));
  const out = [...moved].sort((a, b) => a.at - b.at);
  for (let i = 1; i < out.length; i++) {
    const short = LABEL_GAP - (out[i]!.at - out[i - 1]!.at);
    if (short > 0) { out[i - 1]!.at -= short / 2; out[i]!.at += short / 2; }
  }
  // Back inside the gutter, keeping the gaps: from the bottom up, then from the top down.
  for (let i = out.length - 1; i >= 0; i--) out[i]!.at = Math.min(out[i]!.at, hi - (out.length - 1 - i) * LABEL_GAP);
  for (let i = 0; i < out.length; i++) out[i]!.at = Math.max(out[i]!.at, lo + i * LABEL_GAP, i ? out[i - 1]!.at + LABEL_GAP : -Infinity);
  return moved;
}

/** The index of the point nearest place `at` on the run axis. */
export function nearest(points: readonly Point[], at: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.at - at) < Math.abs(points[best]!.at - at)) best = i;
  return best;
}

/** A dollar figure on the chart: up to four places under a dollar (a learned workflow's run is often a cent or less),
 *  never fewer than two, and two above. */
export function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.0001) return "<$0.0001";
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4).replace(/(\.\d\d\d?)0+$/, "$1").replace(/(\.\d\d)0$/, "$1")}`;
}

/** A level (a mean over many runs): three figures, as a person reads a level ("$0.128"), two places from a dollar up. */
export function level(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.0001) return "<$0.0001";
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toPrecision(3)}`;
}

/** A block of consecutive runs in the execution mix: its first and last run numbers and how many took each path. */
export type Block = { from: number; to: number; runs: number; counts: Record<RunPath, number> };

/** The mix's block size: one run a column up to 20 runs (one block of a few runs says nothing), then blocks of 5 or
 *  more, about 20 blocks at most however many runs there are. */
export const blockSizeOf = (count: number) => (count <= 20 ? 1 : Math.max(5, Math.ceil(count / 20)));

/** The runs that do a job in blocks of `size`, in order (the last may be shorter): every one counts, its cost known or
 *  not; a replay does no job and is in none. */
export function blocksOf(runs: readonly CostRun[], size: number): Block[] {
  const jobs = jobsOf(runs);
  const blocks: Block[] = [];
  for (let i = 0; i < jobs.length; i += size) {
    const slice = jobs.slice(i, i + size);
    // Every path in the legend at 0, so a path's first run counts 1, never NaN.
    const counts = Object.fromEntries(PATHS.map(({ path }) => [path, 0])) as Record<RunPath, number>;
    for (const r of slice) counts[r.path]++;
    blocks.push({ from: slice[0]!.n, to: slice.at(-1)!.n, runs: slice.length, counts });
  }
  return blocks;
}

/** A cost ratio as a person reads it, the one format of every "N times" the console says: a tenth under 10 ("7.0x",
 *  "7.4x"), a whole number from 10 up ("12x"). */
export function timesOf(ratio: number): string {
  const tenth = Math.round(ratio * 10) / 10;
  return `${tenth >= 10 ? Math.round(ratio) : tenth.toFixed(1)}x`;
}

/** A share as a person reads it: a whole percent. */
export const pct = (part: number, whole: number) => `${whole ? Math.round((part / whole) * 100) : 0}%`;
