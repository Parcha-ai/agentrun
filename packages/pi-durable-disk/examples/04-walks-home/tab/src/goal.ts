// A place and a goal: the flag the robot walks to in the hero look, and the page's answer to each request the agent's `do` makes (creature/robot.json's `attempt`). The page plays the request
// (an untrained try, or the learned skill), measures it here, and writes the answer to creature/attempt.json, which `do` reads back and words: the agent says only what these numbers say.
// Pure: the page feeds it the torso's position and uprightness after each control step.

/**
 * Where the walks go, from the start pose (D2's replays in the tab's own Sim and Policy, 20 pushed starts each): code10's walk (the rehearsed dinosaur, command 0.5) crosses x = 3 m at y -0.12 to
 * -0.08 in 6.1-6.2 s, heading -3 to -4 degrees, no falls; code5's at -0.10 to -0.04; the quadruped preset's at -0.04 to 0 (command 0.5) and +0.09 to +0.12 (0.8, its top speed).
 */
export const WALK_CROSSINGS_Y: readonly number[] = [-0.12, -0.08, -0.1, -0.04, 0, 0.09, 0.12];
/**
 * Where the flag stands (metres, in the world: the creature starts at the origin facing +x) and how close counts as there (from the torso). It stands 0.35 m to the left of code10's line (y -0.1)
 * rather than on it: the reach counts from the torso, and a body whose head is half a metre ahead of it would walk through the pole. Every crossing above is within the radius by 0.13 m or more.
 */
export const FLAG = { x: 3, y: 0.25, radius: 0.5 } as const;
/** How long an untrained try plays (simulated seconds): the twitching ramps in after the brain's standing half second. */
export const TRY_S = 4;
/** After a try, how long the creature stays as it ended (lying, if it fell) before it is put back where it stood. */
export const SETTLE_S = 1;
/** A learned run is answered by this time at the latest. */
export const RUN_CAP_S = 15;
/** A learned run that has not come CLOSING_M closer to the flag over the last CLOSING_WINDOW_S is not going there (spin, wave, backwards): it is answered then. */
export const CLOSING_WINDOW_S = 2;
export const CLOSING_M = 0.2;
/** Up to this uprightness the creature is down (the page's own fall threshold). */
export const FALLEN_UP = 0.3;
/**
 * The skills whose policies walk straight ahead from the start pose. A policy has no heading input, so it goes wherever the creature faces; these start from the start pose (origin, facing +x) so
 * the flag is ahead of them. Other skills play where the creature stands.
 */
export const FORWARD_SKILLS: readonly string[] = ['walk', 'sprint'];

export interface Flag { x: number; y: number; radius: number }

/** creature/scene.json: where the flag is, for the agent's `do` (it words how far the creature got). */
export function sceneFile(flag: Flag = FLAG): string {
  return JSON.stringify({ version: 1, flag: { x: flag.x, y: flag.y, radius: flag.radius } }) + '\n';
}

export interface AttemptRequest { id: string; skill: string; learned: boolean }

/** robot.json's `attempt` as the agent's `do` writes it, or null when it is not one. */
export function parseAttemptRequest(v: unknown): AttemptRequest | null {
  if (!v || typeof v !== 'object') return null;
  const { id, skill, learned } = v as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null;
  if (typeof skill !== 'string' || !/^[\w-]{1,40}$/.test(skill) || typeof learned !== 'boolean') return null;
  return { id, skill, learned };
}

/** Why an attempt is over: a try's window ran out; a learned run reached the flag, fell, stopped closing on it, or hit the cap. */
export type Ending = 'window' | 'reached' | 'fell' | 'stalled' | 'cap';

/** creature/attempt.json: the fields the agent's `do` reads (D1's contract, #315). */
export interface AttemptReport {
  version: 1; id: string; skill: string; learned: boolean; fell: boolean;
  /** How far the torso is from where the request found it (straight line, on the ground). */
  distance_m: number;
  /** How far the torso is from the flag at the end. */
  to_flag_m: number;
  reached_flag: boolean;
  /** It was already within the flag's radius when the run started, so this run could not reach it. */
  started_at_flag: boolean;
  seconds: number;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** One request, measured from where it started until it ends. */
export class Attempt {
  readonly request: AttemptRequest;
  readonly flag: Flag;
  private readonly t0: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly startedAtFlag: boolean;
  private fell = false;
  private ending: Ending | null = null;
  private last: { t: number; x: number; y: number };
  /** (time, distance to the flag) per sample, for the closing test. */
  private readonly trace: { t: number; d: number }[] = [];
  private back = 0;

  constructor(request: AttemptRequest, start: { t: number; x: number; y: number }, flag: Flag = FLAG) {
    this.request = request;
    this.flag = flag;
    this.t0 = start.t; this.x0 = start.x; this.y0 = start.y;
    this.last = { ...start };
    const d = this.toFlag(start.x, start.y);
    this.startedAtFlag = d <= flag.radius;
    this.trace.push({ t: start.t, d });
  }

  private toFlag(x: number, y: number): number { return Math.hypot(x - this.flag.x, y - this.flag.y); }

  get ended(): Ending | null { return this.ending; }

  /** The torso after a control step. Returns the ending once the attempt is over, and keeps it: later samples change nothing. */
  sample(t: number, x: number, y: number, up: number): Ending | null {
    if (this.ending) return this.ending;
    this.last = { t, x, y };
    const elapsed = t - this.t0;
    const down = up < FALLEN_UP;
    if (down) this.fell = true;
    if (!this.request.learned) {
      if (elapsed >= TRY_S - 1e-9) this.ending = 'window';
      return this.ending;
    }
    const d = this.toFlag(x, y);
    this.trace.push({ t, d });
    if (down) this.ending = 'fell';
    else if (!this.startedAtFlag && d <= this.flag.radius) this.ending = 'reached';
    else if (elapsed >= CLOSING_WINDOW_S - 1e-9) {
      // the distance CLOSING_WINDOW_S ago: the latest sample at or before then
      while (this.back + 1 < this.trace.length && this.trace[this.back + 1]!.t <= t - CLOSING_WINDOW_S + 1e-9) this.back++;
      if (d > this.trace[this.back]!.d - CLOSING_M) this.ending = 'stalled';
      else if (elapsed >= RUN_CAP_S - 1e-9) this.ending = 'cap';
    }
    return this.ending;
  }

  report(): AttemptReport {
    const { t, x, y } = this.last;
    return {
      version: 1, id: this.request.id, skill: this.request.skill, learned: this.request.learned, fell: this.fell,
      distance_m: round(Math.hypot(x - this.x0, y - this.y0), 2), to_flag_m: round(this.toFlag(x, y), 2),
      reached_flag: this.ending === 'reached', started_at_flag: this.startedAtFlag, seconds: round(t - this.t0, 1),
    };
  }
}
