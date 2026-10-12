// D2's per-skill files, as the stage reads them. Each of the agent's threads has a GPU box that writes /workspace/skills/<skill>/, mirrored to work/skills/<skill>/ on the run's disk:
// skill-progress.jsonl (a line per checkpoint, appended as each lands) and skill.json (written at the start, rewritten at the end: status training | done | failed). Every number is a physical
// one a viewer can follow (m/s, rad/s, a share of time, seconds); there is no reward or loss. Pure: a line that is not understood is counted and skipped, never guessed at.
import type { ShowEvent, Thread } from "./types.ts";

/** The eight skills, in the order of D2's table. */
export const SKILLS = ["walk", "sprint", "backwards", "turn-left", "turn-right", "spin", "wave", "get-up"] as const;

export type SkillPoint = {
  checkpoint: number;
  /** Seconds since that skill's trainer started. */
  seconds: number | null;
  passes: boolean | null;
  metric: { name: string; value: number | null; unit: string | null; target: string | null } | null;
  /** The checkpoint fell in its 10 s test (so it never passes). */
  fell: boolean;
};

const bag = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function point(o: Record<string, unknown>): SkillPoint | null {
  const checkpoint = num(o.checkpoint);
  if (checkpoint === null || !Number.isInteger(checkpoint) || checkpoint < 0) return null;
  const m = bag(o.metric);
  const name = m ? str(m.name) : null;
  return {
    checkpoint,
    seconds: num(o.t),
    passes: typeof o.passes === "boolean" ? o.passes : null,
    metric: m !== null && name !== null ? { name, value: num(m.value), unit: str(m.unit), target: str(m.target) } : null,
    fell: o.fell_at !== null && o.fell_at !== undefined,
  };
}

export function parseSkillProgress(text: string): { points: SkillPoint[]; skipped: number } {
  const points: SkillPoint[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = bag(JSON.parse(line));
      const p = o ? point(o) : null;
      if (p) points.push(p);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { points, skipped };
}

export type SkillJson = { skill: string; label: string | null; status: "training" | "done" | "failed"; wallS: number | null; passedAt: SkillPoint | null };

export function parseSkillJson(text: string): SkillJson | null {
  try {
    const o = bag(JSON.parse(text));
    if (o === null) return null;
    const skill = str(o.skill);
    if (skill === null || (o.status !== "training" && o.status !== "done" && o.status !== "failed")) return null;
    const passed = bag(o.passed_at);
    return { skill, label: str(o.label), status: o.status, wallS: num(o.wall_s), passedAt: passed ? point(passed) : null };
  } catch {
    return null;
  }
}

const STATUS: Record<SkillJson["status"], Thread["status"]> = { training: "learning", done: "done", failed: "failed" };

/**
 * The events for what is new in a skill's files: a thread patch (its label, status and what it is measured by) and the checkpoints after `lastN`. `dir` is the skill's folder name, which stands
 * in for a label the file did not give. Progress with no skill.json yet is a skill that is learning. A status only moves forward: with `known` (the last status said), a status that is not
 * further along is left out, so a skill that is done is never taken back to learning by a read that failed.
 */
const RANK: Record<Thread["status"], number> = { starting: 0, learning: 1, done: 2, failed: 2 };

export function skillEvents(dir: string, json: SkillJson | null, points: readonly SkillPoint[], at: number, lastN: number, known?: Thread["status"]): ShowEvent[] {
  const out: ShowEvent[] = [];
  const fresh = points.filter((p) => p.checkpoint > lastN);
  const latest = fresh.at(-1)?.metric ?? points.at(-1)?.metric ?? null;
  if (json !== null || fresh.length > 0) {
    const status = json ? STATUS[json.status] : "learning";
    out.push({
      t: "thread",
      at,
      id: dir,
      patch: { skill: json?.label ?? dir, ...(known === undefined || RANK[status] > RANK[known] ? { status } : {}), ...(latest ? { metric: latest.name, unit: latest.unit, target: latest.target } : {}) },
    });
  }
  for (const p of fresh) {
    out.push({ t: "thread.point", at, id: dir, n: p.checkpoint, value: p.metric?.value ?? null, ...(p.metric?.unit ? { unit: p.metric.unit } : {}), passes: p.passes, fell: p.fell, seconds: p.seconds });
  }
  return out;
}
