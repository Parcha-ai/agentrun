// The cost per run chart's arithmetic (components/CostPerRun.tsx): which runs it plots, the rolling mean, the y scale
// and where a run's dot goes past the top. The series and what it shows (the takeover, the levels before and after it)
// are the server's (GET /v2/agents/{id}/learning/cost); nothing here says more than the server does.
import type { CostRun, RunPath } from "./v2";

/** The paths in the legend's order, each with its words and its series token (tokens.css --chart-*). */
export const PATHS: readonly { path: RunPath; label: string; fill: string; stroke: string }[] = [
  { path: "agent", label: "By the agent", fill: "fill-chart-agent", stroke: "stroke-chart-agent" },
  { path: "handed_back", label: "Handed back", fill: "fill-chart-handed-back", stroke: "stroke-chart-handed-back" },
  { path: "workflow", label: "Learned workflow", fill: "fill-chart-workflow", stroke: "stroke-chart-workflow" },
];
export const pathOf = (path: RunPath) => PATHS.find((p) => p.path === path)!;

/** A run the chart plots: one whose all-in cost is known. */
export type Point = CostRun & { total_usd: number };
export const plotted = (runs: readonly CostRun[]): Point[] => runs.filter((r): r is Point => r.total_usd !== null);

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

/** The index of the point nearest run `n`. */
export function nearest(points: readonly Point[], n: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.n - n) < Math.abs(points[best]!.n - n)) best = i;
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
