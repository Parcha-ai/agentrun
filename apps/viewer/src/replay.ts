// Where a scrub may stop, and the screen at a stop: the lines before it, reduced. A stop never falls inside a commit
// (RECORDING.md section 4 rule 2), so applying one commit's lines is all or nothing.
import type { Line } from './format.ts';

/** A position `p` means "the lines `[0, p)` have happened". `stops[p]` says whether a scrub may land there. */
export function stopsOf(lines: Line[]): boolean[] {
  const stops = Array.from({ length: lines.length + 1 }, () => true);
  const first = new Map<number, number>();
  const last = new Map<number, number>();
  lines.forEach((line, index) => {
    if (line.channel !== 'durable' || line.commit === undefined || line.snapshot === true) return;
    if (!first.has(line.commit)) first.set(line.commit, index);
    last.set(line.commit, index);
  });
  // Between a commit's first and last line, and between those, no scrub may land.
  for (const [commit, from] of first) for (let p = from + 1; p <= last.get(commit)!; p += 1) stops[p] = false;
  return stops;
}

/** The stop at or before `p`. */
export function snap(stops: boolean[], p: number): number {
  let at = Math.max(0, Math.min(p, stops.length - 1));
  while (at > 0 && !stops[at]) at -= 1;
  return at;
}

/** The next stop after `p`, or `p` at the end. */
export function nextStop(stops: boolean[], p: number): number {
  for (let at = p + 1; at < stops.length; at += 1) if (stops[at]) return at;
  return p;
}

/** The previous stop before `p`, or 0. */
export function previousStop(stops: boolean[], p: number): number {
  for (let at = p - 1; at >= 0; at -= 1) if (stops[at]) return at;
  return 0;
}

/** The last stop whose lines all happened by time `t`. */
export function stopAt(lines: Line[], stops: boolean[], t: number): number {
  let p = 0;
  while (p < lines.length && lines[p]!.t <= t) p += 1;
  return snap(stops, p);
}

/** A pure fold: what a counter or a panel is at a stop is its reduce over the lines before it. */
export type Fold<S> = { init(): S; accepts(line: Line): boolean; reduce(state: S, line: Line): S };

export function reduceTo<S>(fold: Fold<S>, lines: Line[], p: number, keep: (line: Line) => boolean = () => true): S {
  let state = fold.init();
  for (let index = 0; index < p; index += 1) {
    const line = lines[index]!;
    if (keep(line) && fold.accepts(line)) state = fold.reduce(state, line);
  }
  return state;
}
