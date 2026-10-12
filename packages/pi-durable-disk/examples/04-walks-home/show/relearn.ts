// The stumble -> relearn card: what the cluster did for a changed body, aggregated from D2's per-skill skill.json files (one per thread). Nothing is typed in here: the GPUs are the skills trained
// for that body, "all passed in N s" is the largest first-pass time (passed_at.t), "all home" the largest wall time, the CPU time the sum of the skills' own estimates (one machine teaching
// them one after another). The robot's own body is home/skills.json's body_mjcf_sha256: a skill for another body is a relearn. Pure.
import { esc } from "./page/dom.ts";
import type { Thread } from "./types.ts";

/** home/skills.json: the body the robot has now. Only that field is read. */
export function parseHomeSkills(text: string): { bodySha: string } | null {
  try {
    const o = JSON.parse(text) as unknown;
    if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
    const sha = (o as Record<string, unknown>).body_mjcf_sha256;
    return typeof sha === "string" && sha !== "" ? { bodySha: sha } : null;
  } catch {
    return null;
  }
}

export type Relearn = {
  bodyName: string | null;
  /** The skills trained for this body, one GPU each. */
  gpus: number;
  /** How many have passed so far, and, once all have, the largest first-pass time (seconds from each thread's start). */
  passed: number;
  passedS: number | null;
  /** Every thread done: the largest wall time. */
  done: boolean;
  homeS: number | null;
  /** The skills' CPU estimates added up (one machine, one skill after another), when every skill has one, and the machine. */
  cpuS: number | null;
  cpuCores: string | null;
  /** The skills are for a body other than the one the robot has: the cluster is relearning. */
  relearning: boolean;
};

/**
 * The body in question is the one that differs from the robot's home body (a relearn), else the one the skills are for now. A skill that names no body does not count: the stage does not guess.
 */
export function relearnSummary(threads: readonly Thread[], homeBody: string | null): Relearn | null {
  const withBody = threads.filter((t) => t.mjcf !== null);
  if (withBody.length === 0) return null;
  const differs = homeBody === null ? [] : withBody.filter((t) => t.mjcf !== homeBody);
  const body = (differs.length > 0 ? differs : withBody)[0]!.mjcf;
  const ts = withBody.filter((t) => t.mjcf === body);
  const passedAll = ts.every((t) => t.passedS !== null);
  const done = ts.every((t) => t.status === "done");
  const cpuAll = ts.every((t) => t.cpuS !== null);
  return {
    bodyName: ts.find((t) => t.bodyName !== null)?.bodyName ?? null,
    gpus: ts.length,
    passed: ts.filter((t) => t.passedS !== null).length,
    passedS: passedAll ? Math.max(...ts.map((t) => t.passedS!)) : null,
    done,
    homeS: done && ts.every((t) => t.wallS !== null) ? Math.max(...ts.map((t) => t.wallS!)) : null,
    cpuS: cpuAll ? ts.reduce((a, t) => a + t.cpuS!, 0) : null,
    cpuCores: ts.find((t) => t.cpuCores !== null)?.cpuCores ?? null,
    relearning: homeBody !== null && body !== homeBody,
  };
}

const span = (s: number): string => (s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} minutes` : `${(s / 3600).toFixed(1)} hours`);

export function relearnHtml(r: Relearn | null): string {
  if (r === null) return "";
  const name = r.bodyName ?? "a new body";
  const head = r.relearning ? "Learning a new body" : "The robot's body";
  const learned = r.passedS !== null ? `all ${r.gpus} skills passed in ${span(r.passedS)}` : `${r.passed} of ${r.gpus} skills have passed`;
  const home = r.homeS !== null ? `<div class="line">All home in ${esc(span(r.homeS))}</div>` : "";
  const cpu = r.cpuS !== null && r.cpuCores !== null ? `<div class="cpu">On one machine with ${esc(r.cpuCores)}, one skill after another: about ${esc(span(r.cpuS))} (an estimate from this run's own steps and a measured throughput)</div>` : "";
  return `<div class="rl" data-done="${r.done}"><div class="k">${head}</div><div class="who">${esc(name)}</div><div class="line">${r.gpus} GPUs, one skill each: ${esc(learned)}</div>${home}${cpu}</div>`;
}
