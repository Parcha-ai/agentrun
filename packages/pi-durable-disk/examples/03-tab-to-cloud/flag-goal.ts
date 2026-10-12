// The robot's place and goal: a floor with a flag ahead. The page owns the scene and the physics; this is the agent's
// side of the contract (D0 and D1): read where the flag is, wait for the page's report on one request, and say what it
// measured. Before training, `do walk` (or sprint) when that skill has not come home makes the robot try (an untrained
// attempt that fails where everyone can see it); after training, it walks toward the flag. Either way the tool's words come
// from the page's numbers, never from the model. Portable: no Node API; the computer and the clock come in.

/** Where the page says the goal is (written by the page when its scene has one). */
export const SCENE_FILE = "creature/scene.json";
/** The page's report on one request, by its id. */
export const ATTEMPT_FILE = "creature/attempt.json";

export interface Scene {
  /** Metres: x forward from the start, y to the left; the page writes it when a body is built. */
  readonly flag: { readonly x: number; readonly y: number; readonly radius: number };
}

/** What the page measured for one request (the tool's typed result carries it as `details`). */
export type AttemptReport = {
  readonly version: 1;
  readonly id: string;
  readonly skill: string;
  /** False: the skill had not come home, so this was the untrained try. */
  readonly learned: boolean;
  readonly fell: boolean;
  /** How far the torso moved from where the request found it (straight line). */
  readonly distance_m: number;
  /** How far it is from the flag at the end. */
  readonly to_flag_m: number;
  readonly reached_flag: boolean;
  /** True when the robot was already within the flag's radius as the request began (reached_flag then stays false). */
  readonly started_at_flag?: boolean;
  readonly seconds: number;
};

/** The skills a request toward the flag is for: before one that has come home the page sets the robot back at the start
 * facing the flag (D0); other skills play where the robot stands and are not measured against the flag. */
export const FLAG_SKILLS: readonly string[] = ["walk", "sprint"];

/** What the tool needs of the computer: the pi execution environment's file read. */
export interface SceneFiles {
  readTextFile(path: string, context: never): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The flag, when the page's scene has one; undefined otherwise (then `do` behaves as it always has). */
export async function readScene(env: SceneFiles, context: never): Promise<Scene | undefined> {
  const r = await env.readTextFile(SCENE_FILE, context);
  if (!r.ok) return undefined;
  try {
    const v = JSON.parse(r.value) as { version?: unknown; flag?: { x?: unknown; y?: unknown; radius?: unknown } };
    const f = v.flag;
    if (v.version !== 1 || !f || !finite(f.x) || !finite(f.y) || !finite(f.radius) || f.radius <= 0) return undefined;
    return { flag: { x: f.x, y: f.y, radius: f.radius } };
  } catch {
    return undefined;
  }
}

/**
 * The page's report for this request id, waited for up to `timeoutMs`; undefined if none came, "cancelled" as soon as
 * `signal` aborts (the call was cancelled: stop reading, and claim nothing).
 */
export async function waitForAttempt(env: SceneFiles, context: never, id: string, o: { timeoutMs: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<AttemptReport | "cancelled" | undefined> {
  const signal = o.signal;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  }));
  const now = o.now ?? Date.now;
  const deadline = now() + o.timeoutMs;
  for (;;) {
    if (signal?.aborted) return "cancelled";
    const r = await env.readTextFile(ATTEMPT_FILE, context);
    if (signal?.aborted) return "cancelled"; // a read cut short by the cancel is not a missing report
    if (r.ok) {
      try {
        const v = JSON.parse(r.value) as Partial<AttemptReport>;
        if (v.version === 1 && v.id === id && typeof v.skill === "string" && typeof v.learned === "boolean" && typeof v.fell === "boolean" && typeof v.reached_flag === "boolean" && (v.started_at_flag === undefined || typeof v.started_at_flag === "boolean") && finite(v.distance_m) && finite(v.to_flag_m) && finite(v.seconds)) return v as AttemptReport;
      } catch {
        // being written
      }
    }
    if (now() >= deadline) return undefined;
    await sleep(250);
  }
}

/**
 * The skill the robot is playing on a floor with a flag, for the state line: none plays by itself (the page stands the
 * robot at the start and waits for the ask), and a run toward the flag is over once the page has reported it (it stands
 * at the flag, fell, or stopped short). Any other skill the state names is playing.
 */
export async function flagSkill(env: SceneFiles, context: never, robot: { readonly skill?: string; readonly attempt?: { readonly id: string; readonly skill: string; readonly learned: boolean } }): Promise<string | undefined> {
  const a = robot.attempt;
  if (!robot.skill || !a || !a.learned || a.skill !== robot.skill || !FLAG_SKILLS.includes(a.skill)) return robot.skill;
  return (await waitForAttempt(env, context, a.id, { timeoutMs: 0 })) ? undefined : robot.skill;
}

const m = (n: number) => `${Math.round(n * 10) / 10} m`;
const s = (n: number) => `${Math.round(n * 10) / 10} s`;

/** The tool's words for the untrained try: what happened, and that teaching makes it able. */
export function tryText(r: AttemptReport): string {
  const what = r.fell ? `fell after ${s(r.seconds)}, ${m(r.distance_m)} from where it stood` : `stumbled ${m(r.distance_m)} in ${s(r.seconds)} and stayed up`;
  const flag = r.started_at_flag ? "it was already at the flag" : `the flag is still ${m(r.to_flag_m)} away`;
  return `Not learned yet: the robot tried to ${r.skill} and ${what}; ${flag}. teach_skills can teach it to ${r.skill}.`;
}

/** What a learned run adds to `do`'s answer: whether it reached the flag, and how long it took. */
export function runText(r: AttemptReport): string {
  if (r.reached_flag) return `It reached the flag in ${s(r.seconds)}.`;
  if (r.started_at_flag) return `It was already at the flag when it started, so it did not reach it: it ${r.fell ? "fell" : "stopped"} after ${s(r.seconds)}, ${m(r.distance_m)} from where it started.`;
  return `It ${r.fell ? "fell" : "stopped"} after ${s(r.seconds)}, ${m(r.distance_m)} from where it started and ${m(r.to_flag_m)} short of the flag.`;
}

/** How long `do` waits for the page's report: the try runs 4 s of sim time after the page polls (every 1 s); a learned
 * run is reported at the flag, a fall, when it stops closing on the flag, or at 15 s. Tests shorten these. */
export const FLAG_WAIT = { tryMs: 10_000, runMs: 20_000 };

/** When the page did not report in time: say so, and claim nothing either way. */
export const NO_REPORT = "The page did not report the attempt in time, so it cannot be said whether the robot reached the flag.";
/** When the call was cancelled while waiting: the request stands, and nothing is claimed. */
export const CANCELLED = "The request was cancelled before the page reported it, so it cannot be said whether the robot reached the flag.";
