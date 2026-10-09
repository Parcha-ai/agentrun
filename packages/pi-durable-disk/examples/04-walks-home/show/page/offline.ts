// The home beat's proof that the network is off, and how far it walked while it was. Pure.
//
// The banner ("Wi-Fi off - running entirely in your browser") is not a claim the page makes because the browser said so: the browser's offline
// event is one thing, and the page's own attempt to reach the cloud disk, timed, is the other. The banner needs both. If the attempt succeeds the
// page says so plainly and does not say it is offline.

export type Attempt = { ok: boolean; ms: number };

/** What the page's own attempt(s) to reach the cloud disk did. Said as it happened: a success is never shown as a failure. */
export function proofLine(attempts: readonly Attempt[]): string {
  const last = attempts[attempts.length - 1];
  if (!last) return "";
  if (last.ok) return `Cloud: answered in ${Math.round(last.ms)} ms`;
  // A count, never a time: "failed in 1 ms" reads as a blocked call.
  return `Cloud: unreachable (tried ${attempts.length === 1 ? "once" : `${attempts.length} times`})`;
}

export type BannerState = { mode: "on" | "clicked" | "banner" | "contradiction"; label: string };

const GRACE_MS = 6000;

/**
 * `on`: the small control. `clicked`: the user clicked it, or the browser went offline, and nothing has been tried yet (small, "Wi-Fi: off").
 * `banner`: offline AND the page's own attempt failed: the one big banner. `contradiction`: the browser says offline but the cloud answered.
 */
export function bannerState(a: { offline: boolean; clickedAt: number | null; now: number; attempts: readonly Attempt[] }): BannerState {
  const last = a.attempts[a.attempts.length - 1];
  if (a.offline && last && !last.ok) return { mode: "banner", label: "Wi-Fi off - running entirely in your browser" };
  if (a.offline && last && last.ok) return { mode: "contradiction", label: "Wi-Fi: on" };
  const clicked = a.clickedAt !== null && a.now - a.clickedAt < GRACE_MS;
  if (a.offline || clicked) return { mode: "clicked", label: "Wi-Fi: off" };
  return { mode: "on", label: "Wi-Fi: on" };
}

/** One reading from the tab's walk-meter: the straight-line ground distance from where the current version started, at simulated time t. */
export type Meter = { t: number; metres: number; version: number };

/** The two readings that bracket the 10 s boundary may be at most this far apart (the tab reads about once a second): a wider gap is not measured. */
export const MAX_GAP_S = 2;

/**
 * The readings of the latest version that bracket the instant 10 s before the last reading: the last one at or before it, and the first one at
 * or after it. Null when the version has no reading that old, or when the two are too far apart to say what happened in between.
 */
function bracket(samples: readonly Meter[]): { end: Meter; before: Meter; after: Meter } | null {
  const end = samples[samples.length - 1];
  if (!end) return null;
  const boundary = end.t - 10;
  let before: Meter | undefined;
  let after: Meter | undefined;
  for (const s of samples) {
    if (s.version !== end.version) continue;
    if (s.t <= boundary) before = s;
    else if (!after && before) after = s;
  }
  if (!before) return null;
  if (before.t === boundary) return { end, before, after: before };
  if (!after || after.t - before.t > MAX_GAP_S) return null;
  return { end, before, after };
}

/**
 * How far it walked in the last 10 simulated seconds, within one version (a new version starts the distance over): the distance at the last
 * reading minus the distance at exactly 10 s earlier, interpolated between the two readings that bracket that instant. Null when that instant
 * cannot be measured (under 10 s of one version, or the readings around it more than MAX_GAP_S apart), or when the creature ended nearer its
 * start than it began (no claim). The number is never for a longer window than it says.
 */
export function walkedOver10(samples: readonly Meter[]): number | null {
  const b = bracket(samples);
  if (!b) return null;
  const boundary = b.end.t - 10;
  const span = b.after.t - b.before.t;
  const atBoundary = span === 0 ? b.before.metres : b.before.metres + ((b.after.metres - b.before.metres) * (boundary - b.before.t)) / span;
  const d = b.end.metres - atBoundary;
  return d > 0 ? Math.round(d * 10) / 10 : null;
}

/** The readings walkedOver10 can still use: the last version's, from the reading at or before the boundary on. The page keeps only these. */
export function trimMeter(samples: readonly Meter[]): Meter[] {
  const end = samples[samples.length - 1];
  if (!end) return [];
  const boundary = end.t - 10;
  const mine = samples.filter((s) => s.version === end.version);
  let from = 0;
  for (let i = 0; i < mine.length; i++) if (mine[i]!.t <= boundary) from = i;
  return mine.slice(from);
}

/** A reply from the cloud disk counts as the disk answering unless it is the stage saying it could not reach the run's server (a 5xx). */
export function diskAnswered(status: number): boolean {
  return status < 500;
}

/**
 * The page's own attempts to reach the cloud disk. Each attempt can be cancelled, and the result of one that was in flight when probing stopped is
 * dropped, so a late answer never fills the proof of a later offline period.
 */
export class DiskProbe {
  attempts: Attempt[] = [];
  private period = 0;
  private pending = new Set<AbortController>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private fetcher: (signal: AbortSignal) => Promise<{ status: number }>;

  constructor(fetcher: (signal: AbortSignal) => Promise<{ status: number }>) {
    this.fetcher = fetcher;
  }

  async probe(): Promise<void> {
    const period = this.period;
    const controller = new AbortController();
    this.pending.add(controller);
    const started = performance.now();
    let ok: boolean;
    try {
      ok = diskAnswered((await this.fetcher(controller.signal)).status);
    } catch {
      ok = false;
    }
    this.pending.delete(controller);
    if (period !== this.period) return;
    this.attempts = [...this.attempts.slice(-4), { ok, ms: performance.now() - started }];
  }

  start(everyMs = 3000): void {
    if (this.timer) return;
    void this.probe();
    this.timer = setInterval(() => void this.probe(), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.period++;
    for (const c of this.pending) c.abort();
    this.pending.clear();
    this.attempts = [];
  }
}
