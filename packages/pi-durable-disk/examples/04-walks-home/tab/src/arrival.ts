// "It walks home" on the tab side: notice a trained policy landing in the run's work/ (home/policy.json), decide what to do
// with it, and time how long the creature takes to walk with it. Pure logic: the page supplies the source, the clock and
// the simulation, so every branch is testable without a browser.

import { KNOWN_SPEC_VERSIONS } from './policy.ts';
import type { Design } from './design.ts';

export const HOME_POLICY_PATH = 'home/policy.json';

// ---- deciding what to do with a file that arrived -------------------------------------------------------------

export type Plan =
  | { action: 'load'; meta: ArrivalMeta }
  | { action: 'switch-body'; preset: { name: string; design: Design }; meta: ArrivalMeta }
  | { action: 'refuse'; reason: string };

export interface ArrivalMeta {
  /** The machine that trained it, exactly as the file's provenance names it; null when the file does not say. For a combined
   *  walk+getup file this is the walking network's. */
  host: string | null;
  /** Seconds of training wall time from the file's provenance; null when the file does not say. Walking network for a combined file. */
  trainingSeconds: number | null;
  /** A combined file (walking and getup networks trained separately) records the getup network's own host and time. Null when absent. */
  getupHost?: string | null;
  getupSeconds?: number | null;
}

const hostOf = (p: Record<string, unknown> | undefined): string | null => (typeof p?.host === 'string' && p.host.trim() ? p.host.trim() : null);
const secondsOf = (p: Record<string, unknown> | undefined): number | null => {
  const s = p?.wall_s;
  return typeof s === 'number' && Number.isFinite(s) && s >= 0 ? s : null;
};
const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * What the file says about where and how long it trained. Nothing is inferred: a missing or odd field is null. A plain policy
 * carries `provenance.host` and `provenance.wall_s`; a combined walk+getup file (the trainer's combine step) nests them as
 * `provenance.walk` and `provenance.getup`, one per network.
 */
export function arrivalMeta(file: unknown): ArrivalMeta {
  const prov = asRecord(asRecord(file)?.provenance);
  const walk = asRecord(prov?.walk), getup = asRecord(prov?.getup);
  if (walk || getup) {
    return { host: hostOf(walk), trainingSeconds: secondsOf(walk), getupHost: hostOf(getup), getupSeconds: secondsOf(getup) };
  }
  return { host: hostOf(prov), trainingSeconds: secondsOf(prov) };
}

export interface ProvenanceFacts {
  /** Training steps the file says it was trained for; null when it does not say. A combined file's walking network. */
  steps: number | null;
  /** Training wall seconds the file records; null when it does not say. */
  wallS: number | null;
  /** The trainer's own checkpoint number (provenance.checkpoint); null when absent, in which case the tab counts installs. */
  checkpoint: number | null;
  /** The trainer's own 10 s walk score in metres (provenance.walk_10s.distance_m), REPORTED by the file, not measured here. */
  reportedWalk10sM: number | null;
}

const countOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Steps, training time, checkpoint number and the trainer's own walk score, from a plain or a combined (nested) provenance. */
export function provenanceFacts(file: unknown): ProvenanceFacts {
  const prov = asRecord(asRecord(file)?.provenance);
  const src = asRecord(prov?.walk) ?? prov; // a combined file keeps the walking network's record under `walk`
  const walk10 = asRecord(src?.walk_10s);
  const cp = countOf(src?.checkpoint);
  return {
    steps: countOf(src?.steps),
    wallS: countOf(src?.wall_s),
    checkpoint: cp !== null && Number.isInteger(cp) ? cp : null,
    reportedWalk10sM: countOf(walk10?.distance_m),
  };
}

const fmtSeconds = (s: number) => (s < 10 ? s.toFixed(1) : String(Math.round(s)));

/** The toast: both facts when the file has them, otherwise what is missing, never a guess. */
export function describeArrival(meta: ArrivalMeta): string {
  const secs = meta.trainingSeconds === null ? null : fmtSeconds(meta.trainingSeconds);
  const gSecs = meta.getupSeconds == null ? null : fmtSeconds(meta.getupSeconds); // null for both undefined and null
  // `undefined` = a plain file (no getup record); `null` = a combined file whose getup record does not say
  const combined = meta.getupHost !== undefined || meta.getupSeconds !== undefined;
  if (combined) {
    // two networks, trained separately: say what each one's record says, and only that
    const walk = meta.host !== null && secs !== null ? `from ${meta.host} after ${secs} s of walking training`
      : meta.host !== null ? `from ${meta.host} (walking training time not recorded)`
      : secs !== null ? `after ${secs} s of walking training (machine not recorded)` : null;
    const sameHost = meta.getupHost == null || meta.getupHost === meta.host;
    let getup: string | null = null;
    if (gSecs !== null) getup = sameHost ? `and ${gSecs} s of getup training` : `and from ${meta.getupHost} after ${gSecs} s of getup training`;
    else if (!sameHost) getup = `and from ${meta.getupHost} (getup training time not recorded)`;
    if (walk && getup) return `policy arrived ${walk} ${getup}`;
    if (walk) return `policy arrived ${walk} (the file does not say how the getup network was trained)`;
    if (gSecs !== null) return `policy arrived (the file does not say how the walking network was trained; the getup network trained for ${gSecs} s${sameHost ? '' : ` on ${meta.getupHost}`})`;
    return 'policy arrived (the file records neither the machine nor the training time)';
  }
  if (meta.host !== null && secs !== null) return `policy arrived from ${meta.host} after ${secs} s of training`;
  if (meta.host !== null) return `policy arrived from ${meta.host} (the file does not say how long it trained)`;
  if (secs !== null) return `policy arrived after ${secs} s of training (the file does not say which machine)`;
  return 'policy arrived (the file records neither the machine nor the training time)';
}

/**
 * Decide what to do with the text of an arrived policy for the body on screen (`bodySha`). The structural refusals that
 * Policy.load also makes (activation, shapes, version of MuJoCo) are left to it; this covers what decides the action:
 * is it JSON, is it mlp-v1, a spec version we know, and does it belong to this body or to a preset we can switch to.
 */
export async function planArrival(
  text: string,
  bodySha: string,
  presetForSha: (sha: string) => Promise<{ name: string; design: Design } | null>,
): Promise<Plan> {
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(text);
  } catch {
    return { action: 'refuse', reason: 'the file is not valid JSON' };
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) return { action: 'refuse', reason: 'the file is not a policy object' };
  if (file.format !== 'mlp-v1') return { action: 'refuse', reason: `unknown format ${JSON.stringify(file.format)}, expected mlp-v1` };
  if (typeof file.spec_version !== 'number' || !KNOWN_SPEC_VERSIONS.includes(file.spec_version)) {
    return { action: 'refuse', reason: `unknown spec_version ${JSON.stringify(file.spec_version)}` };
  }
  if (typeof file.mjcf_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.mjcf_sha256)) return { action: 'refuse', reason: 'mjcf_sha256 is missing or malformed' };
  const meta = arrivalMeta(file);
  if (file.mjcf_sha256 === bodySha) return { action: 'load', meta };
  const preset = await presetForSha(file.mjcf_sha256);
  if (preset) return { action: 'switch-body', preset, meta };
  return { action: 'refuse', reason: 'the policy was trained for a body that is neither the one on screen nor a preset (mjcf_sha256 differs)' };
}

// ---- noticing it -----------------------------------------------------------------------------------------------

/** Where the file is read from. Swappable: today the embedding page's storage, later a change feed or a GET endpoint. */
export interface PolicySource {
  /** The file's text, or null when it is not there yet. `etag` is the last one seen; a source may answer "unchanged". */
  read(etag?: string): Promise<{ text: string; etag?: string } | 'unchanged' | null>;
}

export interface WatcherDeps {
  sha256: (text: string) => Promise<string>;
  /** Called once per distinct content. Errors are the handler's to report; they do not stop the watcher. */
  onFile: (text: string) => Promise<void> | void;
  onError?: (e: unknown) => void;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** Polls a PolicySource and reports each distinct content once, however many polls see it. */
export class PolicyWatcher {
  private readonly source: PolicySource;
  private readonly deps: WatcherDeps;
  private lastSha: string | null = null;
  private etag: string | undefined;
  private timer: unknown = null;
  private running = false;
  private busy = false;

  constructor(source: PolicySource, deps: WatcherDeps) {
    this.source = source;
    this.deps = deps;
  }

  /** One poll. Returns true when it handed a new file to onFile. */
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const got = await this.source.read(this.etag);
      if (got === null || got === 'unchanged') return false;
      const sha = await this.deps.sha256(got.text);
      this.etag = got.etag ?? this.etag;
      if (sha === this.lastSha) return false;
      this.lastSha = sha;
      await this.deps.onFile(got.text);
      return true;
    } catch (e) {
      this.deps.onError?.(e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Content seen before the watcher started (the policy already on screen) is not an arrival. */
  async prime(): Promise<void> {
    try {
      const got = await this.source.read();
      if (got && got !== 'unchanged') {
        this.lastSha = await this.deps.sha256(got.text);
        this.etag = got.etag;
      }
    } catch (e) {
      this.deps.onError?.(e);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const loop = () => {
      if (!this.running) return;
      void this.tick().finally(() => {
        if (this.running) this.timer = set(loop, this.deps.intervalMs ?? 1000);
      });
    };
    this.timer = set(loop, this.deps.intervalMs ?? 1000);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
}

// ---- one arrival, however many ways it was announced --------------------------------------------------------------

/**
 * The same policy can reach the tab twice for one event: the stage's `load-policy` message and the watcher seeing the file on the
 * disk. Identical content within `windowMs` of the last accepted arrival is the same arrival and is ignored; a later one (a retake,
 * or a file that changed back) is a new arrival.
 */
export class ArrivalDedupe {
  private last: { sha: string; at: number } | null = null;
  private readonly windowMs: number;

  constructor(windowMs = 8000) {
    this.windowMs = windowMs;
  }

  accept(sha: string, nowMs: number): boolean {
    if (this.last && this.last.sha === sha && nowMs - this.last.at < this.windowMs) return false;
    this.last = { sha, at: nowMs };
    return true;
  }
}

// ---- timing: from the file landing to the creature walking -------------------------------------------------------

export interface ArrivalResult {
  /** Page clock: ms from the file being noticed to the policy driving the creature. */
  arrivalToInstalledMs: number;
  /** Page clock: ms from the file being noticed to the first second in which the creature covered at least half the commanded distance; null if it never did within the window, or the command was 0. */
  arrivalToWalkingMs: number | null;
  /** Simulated seconds from installing the policy to that moment. */
  simSecondsToWalking: number | null;
  /** Horizontal distance over the simulated window after install, divided by the window; null until the window has run. */
  meanSpeed: number | null;
  /** The simulated seconds the mean speed covers: the full window, or less when the next install cut it short. */
  windowSeconds: number;
  /** True when a newer install ended the measurement before the window was up. */
  partial: boolean;
  fell: boolean;
  done: boolean;
}

/** Fed one sample per control step after the policy is installed. Everything is relative to the install. */
export class ArrivalTracker {
  private readonly arrivedAtMs: number;
  private readonly installedAtMs: number;
  private readonly command: number;
  private readonly window: number;
  private readonly samples: { t: number; x: number; y: number }[] = [];
  private walkingAtMs: number | null = null;
  private walkingSim: number | null = null;
  private fell = false;
  private mean: number | null = null;
  private cutAt: number | null = null; // simulated seconds of the measurement when it was cut short

  constructor(opts: { arrivedAtMs: number; installedAtMs: number; command: number; windowSeconds?: number }) {
    this.arrivedAtMs = opts.arrivedAtMs;
    this.installedAtMs = opts.installedAtMs;
    this.command = opts.command;
    this.window = opts.windowSeconds ?? 10;
  }

  /** `t` is simulated seconds since install (0 at the install), `up` the torso uprightness. */
  sample(t: number, x: number, y: number, up: number, nowMs: number): void {
    if (this.mean !== null || this.cutAt !== null) return;
    this.samples.push({ t, x, y });
    if (up < 0.3) this.fell = true;
    if (this.walkingAtMs === null && this.command > 0) {
      // the first moment the last simulated second covered at least half of what the command asks for
      const past = [...this.samples].reverse().find((s) => s.t <= t - 1);
      if (past && Math.hypot(x - past.x, y - past.y) >= 0.5 * this.command * (t - past.t) && !this.fell) {
        this.walkingAtMs = nowMs;
        this.walkingSim = t;
      }
    }
    if (t >= this.window) {
      const first = this.samples[0];
      this.mean = Math.hypot(x - first.x, y - first.y) / (t - first.t);
    }
  }

  /**
   * A newer policy replaced this one before the window was up: close the measurement over the simulated seconds it really ran
   * (mean speed over that span), marked partial. Nothing is extrapolated. No-op when it already finished.
   */
  finalize(): void {
    if (this.mean !== null || this.cutAt !== null) return;
    const first = this.samples[0], last = this.samples[this.samples.length - 1];
    const span = first && last ? last.t - first.t : 0;
    this.cutAt = span;
    this.mean = span > 0 ? Math.hypot(last.x - first.x, last.y - first.y) / span : null;
  }

  result(): ArrivalResult {
    return {
      arrivalToInstalledMs: this.installedAtMs - this.arrivedAtMs,
      arrivalToWalkingMs: this.walkingAtMs === null ? null : this.walkingAtMs - this.arrivedAtMs,
      simSecondsToWalking: this.walkingSim,
      meanSpeed: this.mean,
      windowSeconds: this.cutAt ?? this.window,
      partial: this.cutAt !== null,
      fell: this.fell,
      done: this.mean !== null || this.cutAt !== null,
    };
  }
}

// ---- what leaves the tab in an event ----------------------------------------------------------------------------

/** Round every fractional number in an event payload to 3 decimals (nested too): the stage prints what it is given, and 1.999999999999602 is not a number to show. */
export function tidy<T>(v: T): T {
  if (typeof v === 'number') return (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000) as T;
  if (Array.isArray(v)) return v.map(tidy) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x)])) as T;
  return v;
}

/** The policy-walked event. `outcome` is the word for the stage to caption (walked, fell, not-walking, cut-short); the numbers beside it are for display and debugging, and a null among them is "not measured", never a verdict. */
export function walkedFields(name: string, r: ArrivalResult) {
  const walked = r.arrivalToWalkingMs !== null;
  const outcome = r.fell ? 'fell' : walked ? 'walked' : r.partial ? 'cut-short' : 'not-walking';
  return tidy({
    name, outcome, arrival_to_installed_ms: Math.round(r.arrivalToInstalledMs),
    arrival_to_walking_ms: r.arrivalToWalkingMs === null ? null : Math.round(r.arrivalToWalkingMs),
    sim_seconds_to_walking: r.simSecondsToWalking, mean_speed: r.meanSpeed, window_seconds: r.windowSeconds, partial: r.partial, fell: r.fell,
  });
}
