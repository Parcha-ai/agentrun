// One robot, eight teachers. The agent splits into threads (child conversations of the one session), each with its compute on its own GPU and one skill to teach the robot. The stage shows a tile
// per thread while they learn (its skill, its GPU, its checkpoints in its own unit), then the moment every skill lands in the one robot. Pure: state in, HTML out; a number an event did not
// carry is not said.
import { esc } from "./page/dom.ts";
import type { Thread } from "./types.ts";

export type ThreadsPhase = "none" | "learning" | "landing" | "home";

/** `learning`: some thread has not finished. `landing`: every thread has finished and the skills are going into the robot. `home`: every skill that finished is in. A failed thread does not hold the robot back. */
export function threadsPhase(threads: readonly Thread[]): ThreadsPhase {
  if (threads.length === 0) return "none";
  const live = threads.filter((t) => t.status !== "failed");
  if (threads.some((t) => t.status === "starting" || t.status === "learning")) return "learning";
  if (live.length === 0) return "learning";
  return live.every((t) => t.home) ? "home" : "landing";
}

/** The polyline points of a thread's checkpoints inside a w x h box, in order. One point is a dot in the middle; a flat line sits in the middle. */
export function sparkPoints(points: readonly Thread["points"][number][], w: number, h: number): string {
  if (points.length === 0) return "";
  const vs = points.map((p) => p.value);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  return points
    .map((p, i) => {
      const x = points.length === 1 ? w / 2 : (i / (points.length - 1)) * w;
      const y = hi === lo ? h / 2 : h - ((p.value - lo) / (hi - lo)) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

const STATUS: Record<Thread["status"], string> = { starting: "getting a GPU", learning: "learning", done: "done", failed: "failed" };
const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 1e4 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

function tileHtml(t: Thread): string {
  const last = t.points.at(-1);
  const meta = [t.acquireMs !== null ? `GPU in ${seconds(t.acquireMs)}` : null, t.costUsd !== null ? `$${t.costUsd.toFixed(2)}` : null].filter((m) => m !== null).join(" · ");
  const value = last ? `<div class="val">${esc(`${num(last.value)}${t.unit ? ` ${t.unit}` : ""}`)}</div>` : `<div class="val none">${t.status === "failed" ? "no checkpoint" : "waiting for its first checkpoint"}</div>`;
  const spark = t.points.length > 0 ? `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><polyline points="${sparkPoints(t.points, 100, 40)}"/></svg>` : "";
  return `<div class="tile" data-id="${esc(t.id)}" data-status="${t.status}"><div class="top"><span class="skill">${esc(t.skill ?? "a skill")}</span><span class="st">${STATUS[t.status]}</span></div><div class="host">${esc(t.host ?? "a GPU")}</div>${spark}${value}${meta ? `<div class="meta">${esc(meta)}</div>` : ""}</div>`;
}

const ROBOT = `<svg class="robot" viewBox="0 0 120 80" aria-hidden="true"><rect x="30" y="18" width="60" height="26" rx="8"/><circle cx="76" cy="28" r="3.5" class="eye"/><path d="M38 44 L30 70 M54 44 L50 70 M70 44 L74 70 M86 44 L96 70" /></svg>`;

/** The centre view for the threads: tiles while they learn; the one robot with each skill lighting as it lands, then all of them. Empty when there are no threads. */
export function threadsHtml(threads: readonly Thread[]): string {
  const phase = threadsPhase(threads);
  if (phase === "none") return "";
  if (phase === "learning") {
    return `<div class="th" data-phase="learning"><div class="thead">The agent split into ${threads.length} thread${threads.length === 1 ? "" : "s"}, one per GPU</div><div class="tiles">${threads.map(tileHtml).join("")}</div></div>`;
  }
  const live = threads.filter((t) => t.status !== "failed");
  const inCount = live.filter((t) => t.home).length;
  const head = phase === "home" ? `All ${live.length} skills are in the robot` : `${inCount} of ${live.length} skills are in the robot`;
  const chips = threads.map((t) => `<span class="${t.status === "failed" ? "skill failed" : t.home ? "skill in" : "skill"}">${esc(t.skill ?? "a skill")}</span>`).join("");
  return `<div class="th" data-phase="${phase}"><div class="thead">${head}</div>${ROBOT}<div class="skills">${chips}</div></div>`;
}
