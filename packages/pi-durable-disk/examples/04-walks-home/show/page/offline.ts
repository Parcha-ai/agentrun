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
  if (last.ok) return `Cloud disk: answered in ${Math.round(last.ms)} ms`;
  const tried = attempts.length > 1 ? `tried ${attempts.length} times, last failed in` : "failed in";
  return `Cloud disk: no answer (${tried} ${Math.round(last.ms)} ms)`;
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

/**
 * How far it walked in the last 10 simulated seconds: the change in its distance from the version's starting spot, within one version (a new version
 * starts the distance over). Null when there are not 10 s of one version, or when the creature ended nearer its start than it began (no claim).
 */
export function walkedOver10(samples: readonly Meter[]): number | null {
  const end = samples[samples.length - 1];
  if (!end) return null;
  let start: Meter | undefined;
  for (const s of samples) if (s.version === end.version && s.t <= end.t - 10) start = s;
  if (!start) return null;
  const d = end.metres - start.metres;
  return d > 0 ? Math.round(d * 10) / 10 : null;
}
