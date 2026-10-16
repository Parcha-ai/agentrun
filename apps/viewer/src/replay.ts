// Where a scrub may stop, and the screen at a stop: the lines before it, reduced. A stop never falls inside a commit
// (RECORDING.md section 4 rule 2), so applying one commit's lines is all or nothing.
import { isSupervisor, restoresOf, type Line } from './format.ts';

/** A position `p` means "the lines `[0, p)` have happened". `stops[p]` says whether a scrub may land there: never
 *  inside a commit, and never inside a process's snapshot (one state, written at its open). */
export function stopsOf(lines: Line[]): boolean[] {
  const stops = Array.from({ length: lines.length + 1 }, () => true);
  const restores = restoresOf(lines);
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  // A restore numbers its commits again from the checkpoint (RECORDING.md 3.2), so a commit is keyed by its segment.
  let segment = 0;
  let run: [number, number] | undefined;
  const runs: [number, number][] = [];
  let opened = false;
  lines.forEach((line, index) => {
    if (restores.has(index)) segment += 1;
    if (isSupervisor(line) && line.kind === 'process.started') opened = true;
    if (line.channel !== 'durable' || line.commit === undefined) return;
    if (line.snapshot === true) {
      if (!run || opened) { if (run) runs.push(run); run = [index, index]; } else run[1] = index;
      opened = false;
      return;
    }
    if (run) { runs.push(run); run = undefined; }
    const key = `${segment} ${line.commit}`;
    if (!first.has(key)) first.set(key, index);
    last.set(key, index);
  });
  if (run) runs.push(run);
  // Between a commit's first and last line, and between a snapshot's, no scrub may land.
  for (const [key, from] of first) for (let p = from + 1; p <= last.get(key)!; p += 1) stops[p] = false;
  for (const [from, to] of runs) for (let p = from + 1; p <= to; p += 1) stops[p] = false;
  return stops;
}

/** The stop at or before `p`. */
export function snap(stops: boolean[], p: number): number {
  let at = Math.max(0, Math.min(p, stops.length - 1));
  while (at > 0 && !stops[at]) at -= 1;
  return at;
}

/** A `?t=` value (seconds) as the playback clock in ms; anything that is not a non-negative number is no time. */
export function timeParam(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  const ms = seconds * 1000;
  return Number.isFinite(ms) && seconds >= 0 ? ms : undefined;
}

/** The `?t=` a URL keeps: the time the link opened at, while the clock is still there; once the user has sought or played on, no time (a reload would undo it). */
export const linkedTime = (opened: number | undefined, clock: number): string | undefined => (opened !== undefined && clock === opened ? String(opened / 1000) : undefined);

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

export function reduceTo<S>(fold: Fold<S>, lines: Line[], p: number): S {
  let state = fold.init();
  for (let index = 0; index < p; index += 1) {
    const line = lines[index]!;
    if (fold.accepts(line)) state = fold.reduce(state, line);
  }
  return state;
}

/** Playback over a recording's stops: the clock runs with the wall clock times the speed, and only a seek sets it, so
 *  a redraw (a focus change, a line reached) never drops the time that has run. */
export function playback(lines: Line[], stops: boolean[]) {
  let clock = 0;
  let p = 0;
  return {
    get p() { return p; },
    get clock() { return clock; },
    /** Go to the stop at or before `to`, its clock the time of the last line before it. */
    seek(to: number) { p = snap(stops, to); clock = p > 0 ? lines[p - 1]!.t : 0; return p; },
    /** Go to the time `ms`: the stop whose lines all happened by then, with the clock at `ms` itself (a link to second 20 shows second 20), never past the end of the run (`?t=1e300` opens at the end, not at a thousand-digit time). */
    seekTime(ms: number) { clock = Math.min(Math.max(0, ms), lines.length > 0 ? lines[lines.length - 1]!.t : 0); p = stopAt(lines, stops, clock); return p; },
    /** Run the clock `ms` of wall time at `speed`; the stop is the last whose lines all happened by then. */
    advance(ms: number, speed: number) { clock += ms * speed; p = stopAt(lines, stops, clock); return p; },
  };
}
