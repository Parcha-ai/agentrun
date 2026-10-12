// The stumble -> relearn card: what the cluster did for a changed body, aggregated from D2's per-skill skill.json files (one per thread). Nothing is typed in here: the GPUs are the skills trained
// for that body, "all passed in N s" is the largest first-pass time (passed_at.t), "all home" the largest wall time, the CPU time the sum of the skills' own estimates (one machine teaching
// them one after another). The robot's own body is home/skills.json's body_mjcf_sha256: a skill for another body is a relearn. Pure.
import { esc } from "./page/dom.ts";
import type { Round, Stumble, Thread } from "./types.ts";

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

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** work/skills/round.json (D2's assembler writes it after the threads): the round's own summary. Version 1 only; anything else, or no body, is nothing. */
export function parseRound(text: string): Round | null {
  try {
    const o = JSON.parse(text) as unknown;
    if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
    const r = o as Record<string, unknown>;
    const bodySha = strOrNull(r.body_mjcf_sha256);
    if (r.version !== 1 || bodySha === null) return null;
    const cpu = r.cpu_estimate !== null && typeof r.cpu_estimate === "object" ? (r.cpu_estimate as Record<string, unknown>) : null;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return {
      bodySha,
      bodyName: strOrNull(r.body_name),
      previousSha: strOrNull(r.previous_body_mjcf_sha256),
      relearn: r.relearn === true,
      gpus: num(r.gpus),
      allPassedS: num(r.all_passed_s),
      allDoneS: num(r.all_done_s),
      cpuS: num(r.cpu_estimate_s),
      cpuCores: cpu ? strOrNull(cpu.cores) : null,
      estimated: list(r.estimated),
      measured: list(r.measured),
    };
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
  /** The numbers come from the round's own summary (round.json), not only from adding up the skill files. */
  fromRound: boolean;
  /** The tab said the body changed and these skills no longer fit it, and no skill file for the new body has appeared yet: the card is the stumble, and claims no GPU. Null once skills for that body exist. */
  stumbled: string[] | null;
};

/**
 * The body in question is the one that differs from the robot's home body (a relearn), else the one the skills are for now. A skill that names no body does not count: the stage does not guess.
 */
export function relearnSummary(threads: readonly Thread[], homeBody: string | null, roundIn: Round | null = null, stumble: Stumble | null = null): Relearn | null {
  // The tab's body-mismatch names the body being relearned: a round of another (older) body is not this relearn's.
  const round = roundIn !== null && stumble !== null && roundIn.bodySha !== stumble.bodySha ? null : roundIn;
  const withBody = threads.filter((t) => t.mjcf !== null);
  if (stumble !== null && round === null && !withBody.some((t) => t.mjcf === stumble.bodySha)) {
    return { bodyName: null, gpus: 0, passed: 0, passedS: null, done: false, homeS: null, cpuS: null, cpuCores: null, relearning: true, fromRound: false, stumbled: stumble.notFitting };
  }
  if (withBody.length === 0 && round === null) return null;
  const differs = homeBody === null ? [] : withBody.filter((t) => t.mjcf !== homeBody);
  const body = round?.bodySha ?? stumble?.bodySha ?? (differs.length > 0 ? differs : withBody)[0]!.mjcf;
  const ts = withBody.filter((t) => t.mjcf === body);
  const passedAll = ts.length > 0 && ts.every((t) => t.passedS !== null);
  const doneAll = ts.length > 0 && ts.every((t) => t.status === "done");
  // One machine's time needs every skill to name that same machine: a missing or different label shows no total (the sum would not be that machine's).
  const cores = ts.length > 0 && ts.every((t) => t.cpuCores !== null && t.cpuCores === ts[0]!.cpuCores) ? ts[0]!.cpuCores : null;
  const cpuAll = cores !== null && ts.every((t) => t.cpuS !== null);
  // The skill files fill a total the round left null only when every skill the round counted is there (a read that failed must not turn 5 of 8 into "all").
  const complete = round === null || round.gpus === null || ts.length === round.gpus;
  const own = {
    passedS: complete && passedAll ? Math.max(...ts.map((t) => t.passedS!)) : null,
    homeS: complete && doneAll && ts.every((t) => t.wallS !== null) ? Math.max(...ts.map((t) => t.wallS!)) : null,
    cpuS: complete && cpuAll ? ts.reduce((a, t) => a + t.cpuS!, 0) : null,
    cpuCores: complete && cpuAll ? cores : null,
  };
  return {
    bodyName: round?.bodyName ?? ts.find((t) => t.bodyName !== null)?.bodyName ?? null,
    gpus: round?.gpus ?? ts.length,
    passed: ts.filter((t) => t.passedS !== null).length,
    // The round's own totals when it gave them; a total it left null falls back to what the skill files add up to.
    passedS: round?.allPassedS ?? own.passedS,
    done: round !== null || doneAll,
    homeS: round?.allDoneS ?? own.homeS,
    cpuS: round?.cpuS ?? own.cpuS,
    cpuCores: round?.cpuS != null ? (round.cpuCores ?? null) : own.cpuCores,
    relearning: round ? round.relearn : homeBody !== null && body !== homeBody,
    fromRound: round !== null,
    stumbled: null,
  };
}

const span = (s: number): string => (s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} minutes` : `${(s / 3600).toFixed(1)} hours`);

export function relearnHtml(r: Relearn | null): string {
  if (r === null) return "";
  const name = r.bodyName ?? "a new body";
  if (r.stumbled !== null) {
    const n = r.stumbled.length;
    return `<div class="rl" data-done="false"><div class="k">The robot's body changed</div><div class="who">${esc(name)}</div><div class="line">${n} ${n === 1 ? "skill no longer fits" : "skills no longer fit"} it: ${esc(r.stumbled.join(", "))}</div><div class="cpu">The robot stumbles until they are relearned for this body.</div></div>`;
  }
  const head = r.done && r.fromRound ? (r.relearning ? "Relearned its new body" : "Learned its body") : r.relearning ? "Learning a new body" : "The robot's body";
  // D2's times count from each thread's own start (warm-up and the pool's acquire time are not in them).
  const learned = r.passedS !== null ? `all ${r.gpus} skills passed in ${span(r.passedS)} (from each thread's start)` : `${r.passed} of ${r.gpus} skills have passed`;
  const home = r.homeS !== null ? `<div class="line">All home in ${esc(span(r.homeS))}</div>` : "";
  const cpu = r.cpuS !== null && r.cpuCores !== null ? `<div class="cpu">On one machine with ${esc(r.cpuCores)}, one skill after another: about ${esc(span(r.cpuS))} (an estimate from this run's own steps and a measured throughput)</div>` : "";
  return `<div class="rl" data-done="${r.done}"><div class="k">${head}</div><div class="who">${esc(name)}</div><div class="line">${r.gpus} GPUs, one skill each: ${esc(learned)}</div>${home}${cpu}</div>`;
}
