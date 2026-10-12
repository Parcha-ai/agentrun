// One robot, eight teachers. The agent splits into threads (child conversations of the one session), each with its compute on its own GPU and one skill to teach the robot. The stage shows a tile
// per thread while they learn (its skill, its GPU, its checkpoints in its own unit), then the moment every skill lands in the one robot. Pure: state in, HTML out; a number an event did not
// carry is not said.
import { esc } from "./page/dom.ts";
import { SKILL_LABELS } from "./skills.ts";
import type { ShowState, Thread } from "./types.ts";

export type ThreadsPhase = "none" | "learning" | "landing" | "home";

/** `learning`: some thread has not finished. `landing`: every thread has finished and the skills are going into the robot. `home`: every skill that finished is in. A failed thread does not hold the robot back. */
export function threadsPhase(threads: readonly Thread[]): ThreadsPhase {
  if (threads.length === 0) return "none";
  const live = threads.filter((t) => t.status !== "failed");
  if (threads.some((t) => t.status === "starting" || t.status === "learning")) return "learning";
  if (live.length === 0) return "learning";
  return live.every((t) => t.home) ? "home" : "landing";
}

/** The polyline points of a thread's checkpoints inside a w x h box, in order. One point is a dot in the middle; a flat line sits in the middle; a checkpoint with no value is not drawn and the others keep their places. */
export function sparkPoints(points: readonly Thread["points"][number][], w: number, h: number): string {
  const vs = points.flatMap((p) => (p.value === null ? [] : [p.value]));
  if (vs.length === 0) return "";
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  return points
    .flatMap((p, i) => {
      if (p.value === null) return [];
      const x = points.length === 1 ? w / 2 : (i / (points.length - 1)) * w;
      const y = hi === lo ? h / 2 : h - ((p.value - lo) / (hi - lo)) * h;
      return [`${x.toFixed(1)},${y.toFixed(1)}`];
    })
    .join(" ");
}

const STATUS: Record<Thread["status"], string> = { starting: "getting a GPU", learning: "learning", done: "done", failed: "failed" };
const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 1e4 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

/**
 * How far a value is toward the number its skill needs, 0 to 1, from the target as the skill's file words it (">= 0.4", "<= -0.25"). A target that is prose (get-up: "rights itself from left, right and back"),
 * a lower-is-better limit above zero, or a value the checkpoint did not have is nothing: the bar is not drawn rather than guessed.
 */
export function progressToward(value: number | null, target: string | null): number | null {
  const m = target === null ? null : /^\s*(>=|≥|>|<=|≤|<)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(target);
  if (value === null || m === null) return null;
  const limit = Number(m[2]);
  const upward = m[1] === ">=" || m[1] === "≥" || m[1] === ">";
  if (limit === 0 || (upward && limit < 0) || (!upward && limit > 0)) return null;
  return Math.min(1, Math.max(0, value / limit));
}

function tileHtml(t: Thread): string {
  const last = t.points.at(-1);
  const meta = [t.acquireMs !== null ? `GPU in ${seconds(t.acquireMs)}` : null, t.costUsd !== null ? `$${t.costUsd.toFixed(2)}` : null].filter((m) => m !== null).join(" · ");
  let body: string;
  // The small facts live on hover, so the tile itself is the skill, one big number and whether it passes.
  const detail: string[] = [t.host ?? "a GPU"];
  if (!last) body = `<div class="val none">${t.status === "failed" ? "no checkpoint" : "waiting for its first checkpoint"}</div>`;
  else {
    const what = t.metric ?? "value";
    const value = last.value === null ? `${esc(what)}: no value yet` : `${esc(what)} <span class="n">${esc(num(last.value))}</span>${t.unit ? ` ${esc(t.unit)}` : ""}`;
    const verdict =
      last.fell ? `<span class="pass no">fell in its test</span>` : last.passes === true ? `<span class="pass yes">passes</span>` : last.passes === false ? `<span class="pass no">not yet</span>` : "";
    const progress = progressToward(last.value, t.target);
    const bar = progress === null ? "" : `<div class="bar${last.passes === true ? " yes" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress * 100)}"><i style="width:${Math.round(progress * 100)}%"></i></div>`;
    body = `<div class="val">${value}</div>${bar}${verdict}`;
    detail.push(`checkpoint ${last.n}${last.seconds !== null ? ` · ${seconds(last.seconds * 1000)} in` : ""}`);
    if (last.passes === false && t.target) detail.push(`needs ${t.target}`);
  }
  const spark = t.points.some((p) => p.value !== null) ? `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><polyline points="${sparkPoints(t.points, 100, 40)}"/></svg>` : "";
  if (meta) detail.push(meta);
  return `<div class="tile" data-id="${esc(t.id)}" data-status="${t.status}" title="${esc(detail.join(" · "))}"><div class="top"><span class="skill">${esc(t.skill ?? "a skill")}</span><span class="st">${STATUS[t.status]}</span></div>${spark}${body}</div>`;
}

/**
 * The run is home when the place says so, or when it is back in the tab after a stay somewhere else (the live feed's place after coming back is "tab", not "home"): the skills of a finished
 * round go into the robot only then.
 */
export function runIsHome(state: Pick<ShowState, "place" | "stays">): boolean {
  return state.place.where === "home" || (state.place.where === "tab" && state.stays.some((s) => s.hostKind !== "tab"));
}

/** The threads in the order of the expected skills, with a waiting thread for each expected skill that has none yet; threads of other skills stay, after them. */
export function withExpected(threads: readonly Thread[], expected: readonly string[]): Thread[] {
  const known = new Map(threads.map((t) => [t.id, t]));
  const rank = (id: string) => {
    const i = expected.indexOf(id);
    return i < 0 ? expected.length : i;
  };
  const waiting = expected.filter((id) => !known.has(id)).map(
    (id): Thread => ({ id, skill: SKILL_LABELS[id as keyof typeof SKILL_LABELS] ?? id, host: null, status: "starting", acquireMs: null, costUsd: null, metric: null, unit: null, target: null, mjcf: null, bodyName: null, passedS: null, wallS: null, cpuS: null, cpuCores: null, home: false, points: [], at: 0 }),
  );
  return [...threads, ...waiting].map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.i - b.i).map((x) => x.t);
}

/**
 * The centre view for the threads: tiles while they learn (with `expected`, a waiting tile for each skill whose thread has not started, so the agent is one agent split into eight from the first
 * thread on); once they have finished, the skills that go into the robot, lighting as they land (the real creature in the page stays visible beneath: nothing is drawn over it). Empty with no threads.
 */
export function threadsHtml(threads: readonly Thread[], expected: readonly string[] = []): string {
  const phase = threadsPhase(threads);
  if (phase === "none") return "";
  if (phase === "learning") {
    const shown = expected.length > 0 ? withExpected(threads, expected) : threads;
    return `<div class="th" data-phase="learning"><div class="thead">The agent split into ${shown.length} thread${shown.length === 1 ? "" : "s"}, one per GPU</div><div class="tiles">${shown.map(tileHtml).join("")}</div></div>`;
  }
  const live = threads.filter((t) => t.status !== "failed");
  const inCount = live.filter((t) => t.home).length;
  const head = phase === "home" ? `All ${live.length} skills are in the robot` : `${inCount} of ${live.length} skills are in the robot`;
  const chips = threads.map((t) => `<span class="${t.status === "failed" ? "skill failed" : t.home ? "skill in" : "skill"}">${esc(t.skill ?? "a skill")}</span>`).join("");
  return `<div class="th" data-phase="${phase}"><div class="thead">${head}</div><div class="skills">${chips}</div></div>`;
}

/** The thread whose skill goes into the robot next: when every thread has finished and the run is home, the first finished one not in yet, in their order. Null when none is due. */
export function nextToLand(threads: readonly Thread[], runIsHome: boolean): string | null {
  if (!runIsHome || threads.length === 0 || threads.some((t) => t.status === "starting" || t.status === "learning")) return null;
  return threads.find((t) => t.status === "done" && !t.home)?.id ?? null;
}

/** What the page knows about how the skills go into the robot, for one run: once the tab has said a skill is installed the stage stops landing them itself, and a new run starts over. */
export class LandingDriver {
  private installed = false;

  noteInstalled(): void {
    this.installed = true;
  }

  reset(): void {
    this.installed = false;
  }

  next(threads: readonly Thread[], runIsHome: boolean): string | null {
    return this.installed ? null : nextToLand(threads, runIsHome);
  }
}
