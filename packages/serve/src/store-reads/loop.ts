// GET /agents/{id}/learning/loop from the one store: what the console's Learning tab tells of the self-learning loop
// beside the cost series. Each compile turn the agent's runs took (learn/compile.ts: the workflow it wrote, the notes it
// absorbed, each attempt and what the checks refused, the draft's digest and whether that revision serves), and each
// guarded step of its learned workflows (runner/step-guard.ts rows on a run's metrics.guards): its signal and threshold,
// how often it handed the run back, and each run's p, with the run's grade when the workflow's own answer was graded.
// Aggregates and the checks' own words only: no input, no answer.
import { FINAL_STATES, type Store } from "../store/store.js";
import type { GuardRow } from "../learned-nodes.js";
import { GRADES_KEPT, gradesOf, promotionsOf } from "../learn/promote.js";
import { promotedOf } from "../learn/compile.js";
import { roundsOf } from "./learning.js";

/** How many compile turns the read gives, the newest. */
export const LOOP_COMPILES_MAX = 50;
/** How many runs' p a guarded step gives, its newest. */
export const LOOP_POINTS_MAX = 200;

/** One compile turn of a run, in the round of it that compiled (a follow-up opens a round past the first, and each
 *  round's end may compile): `errors` its draft's when none passed (never silent). */
export type LoopCompile = {
  run_id: string;
  round: number;
  at: string;
  workflow: string | null;
  from_notes: string[];
  attempts: { ok: boolean; errors: string[] }[];
  digest: string | null;
  promoted: boolean | null;
  draft_errors: string[];
};
/** One run's guard outcome on a step: its p (the least its checks read, a step in a map checking once per item; null
 *  when a signal was missing on one: it handed back), whether one of its checks handed back, and, when the run's answer
 *  was the workflow's own and it was graded, whether that was right. */
export type LoopPoint = { run_id: string; p: number | null; escalated: boolean; correct: boolean | null };
/** One guarded step of one revision of a learned workflow, over the runs it served first on (each run once, however many
 *  checks a map made of it): its threshold as those runs read it (null when only replays ran it), how many it guarded and
 *  handed back, how many of those the workflow answered
 *  alone were graded right and wrong, each over every such run, and the newest runs' p. A replay run reads its guards at
 *  RECORD_ONLY_THRESHOLD (learn/promote.ts: it hands back on nothing it reads), so its row says nothing of a hand-back
 *  at the serving threshold: it is counted apart (`replays`) and in none of the others. */
export type LoopGuard = {
  workflow: string;
  digest: string;
  node: string;
  signal: GuardRow["signal"];
  threshold: number | null;
  runs: number;
  escalated: number;
  right: number;
  wrong: number;
  /** Runs it answered alone whose grade, if one was given, is no longer kept (the agent keeps its newest GRADES_KEPT
   *  grades): in neither `right` nor `wrong`, never read as "not graded". */
  grades_past: number;
  replays: number;
  points: LoopPoint[];
};

const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((one): one is string => typeof one === "string") : []);
const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

/** A run's guard rows of `workflow`'s calls as its record keeps them (metrics.guards), read as untrusted: a row out of
 *  shape is left out, and so is one another workflow's call made (the agent can call one after the first hands back: the
 *  run's digest is the first's, so the other's revision is not known here). */
function guardRowsOf(metrics: unknown, workflow: string): GuardRow[] {
  const rows = (metrics as { guards?: unknown } | null | undefined)?.guards;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is GuardRow => {
    const r = row as Partial<GuardRow> | null;
    return !!r && r.workflow === workflow && typeof r.node === "string" && (r.signal === "self" || r.signal === "jev" || r.signal === "both") && typeof r.threshold === "number" && typeof r.escalated === "boolean" && (r.p === null || typeof r.p === "number");
  });
}

/** A run's checks of each step, one outcome per step (a step in a map checks once per item): handed back when any check
 *  did, its p the least one read (null when one read none), its threshold the last check's; in the order each step first
 *  checked. */
function perStep(rows: readonly GuardRow[]): { node: string; signal: GuardRow["signal"]; threshold: number; p: number | null; escalated: boolean }[] {
  const steps = new Map<string, { node: string; signal: GuardRow["signal"]; threshold: number; p: number | null; escalated: boolean }>();
  for (const row of rows) {
    const was = steps.get(row.node);
    if (!was) {
      steps.set(row.node, { node: row.node, signal: row.signal, threshold: row.threshold, p: row.p, escalated: row.escalated });
      continue;
    }
    was.threshold = row.threshold;
    was.escalated ||= row.escalated;
    was.p = was.p === null || row.p === null ? null : Math.min(was.p, row.p);
  }
  return [...steps.values()];
}

/** The agent's compile turns (every round of each run, roundsOf: newest first, LOOP_COMPILES_MAX) and its learned
 *  workflows' guarded steps, over its ended runs (not imported, not archived). A compile's `promoted` is its revision's
 *  promotion as the records say now (null while undecided): whether it serves now is the promotions read's `serving`. A step's `correct` is the run's grade only on a run its workflow answered alone (path `workflow`): a
 *  hand-back's answer was the agent's, and a replay run is never graded. */
export async function agentLoopOverStore(store: Store, agentId: string): Promise<{ compiles: LoopCompile[]; guards: LoopGuard[] }> {
  const ended = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId && FINAL_STATES.includes(run.state) && !run.importedFrom && run.archivedAt === null).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const [grades, promotions] = await Promise.all([gradesOf(store.settings, agentId).catch(() => []), promotionsOf(store.settings, agentId).catch(() => [])]);
  const graded = new Map(grades.map((grade) => [grade.run, grade.correct]));
  // The grades kept are the newest GRADES_KEPT (putGrade trims the oldest): once full, a run that ended before the oldest
  // grade kept and has none kept may have had one trimmed, so its grade is unknown. A run that ended after it with none
  // kept was never graded (a grade of it would be newer than one kept). Not full: nothing was trimmed.
  const kept = grades.map((grade) => Date.parse(grade.at)).filter(Number.isFinite);
  const keptSince = grades.length >= GRADES_KEPT ? (kept.length ? Math.min(...kept) : Infinity) : -Infinity;
  const compiles: (LoopCompile & { createdAt: number })[] = [];
  const steps = new Map<string, LoopGuard>();
  for (const run of ended) {
    const metrics = run.metrics as { path?: unknown; workflow?: unknown; workflow_digest?: unknown } | null | undefined;
    const workflow = typeof metrics?.workflow === "string" ? metrics.workflow : null;
    const digest = typeof metrics?.workflow_digest === "string" ? metrics.workflow_digest : null;
    if (workflow && digest) {
      const alone = metrics?.path === "workflow";
      for (const row of perStep(guardRowsOf(run.metrics, workflow))) {
        const key = `${workflow}\u0000${digest}\u0000${row.node}`;
        const step = steps.get(key) ?? { workflow, digest, node: row.node, signal: row.signal, threshold: null, runs: 0, escalated: 0, right: 0, wrong: 0, grades_past: 0, replays: 0, points: [] };
        steps.set(key, step);
        if (metrics?.path === "replay") {
          step.replays += 1;
          continue;
        }
        const correct = alone ? (graded.get(run.id) ?? null) : null;
        step.threshold = row.threshold;
        step.runs += 1;
        if (row.escalated) step.escalated += 1;
        if (correct === true) step.right += 1;
        if (correct === false) step.wrong += 1;
        if (alone && correct === null && (run.endedAt ?? run.startedAt) < keptSince) step.grades_past += 1;
        step.points.push({ run_id: run.id, p: row.p === null ? null : round4(row.p), escalated: row.escalated, correct });
      }
    }
    for (const kept of await roundsOf(store, run.id).catch(() => [])) {
      const row = (kept.proposal ?? null) as { compiled?: unknown; draft_errors?: unknown } | null;
      if (!row) continue;
      const errors = texts(row.draft_errors);
      const record = row.compiled as { workflow?: unknown; from_notes?: unknown; attempts?: unknown; digest?: unknown } | undefined;
      const named = record && typeof record === "object" && typeof record.workflow === "string" ? record : undefined;
      if (!named && !errors.length) continue;
      const attempts = Array.isArray(named?.attempts) ? named.attempts.filter((one) => one && typeof one === "object" && typeof (one as { ok?: unknown }).ok === "boolean").map((one) => ({ ok: (one as { ok: boolean }).ok, errors: texts((one as { errors?: unknown }).errors) })) : [];
      const kept16 = typeof named?.digest === "string" && /^[0-9a-f]{16}$/.test(named.digest) ? named.digest : null;
      compiles.push({
        createdAt: kept.createdAt, run_id: run.id, round: kept.round, at: new Date(kept.createdAt).toISOString(), workflow: named ? (named.workflow as string) : null, from_notes: texts(named?.from_notes), attempts,
        digest: kept16, promoted: named && kept16 ? (promotedOf(promotions, named.workflow as string, kept16) ?? null) : null, draft_errors: errors,
      });
    }
  }
  const guards = [...steps.values()].map((step) => ({ ...step, points: step.points.slice(-LOOP_POINTS_MAX) }));
  // Newest first by when each round kept it (a later round of an earlier run can be newer than a later run's), the run's
  // start and its round breaking a tie.
  const newest = compiles.map((one, i) => ({ one, i })).sort((a, b) => b.one.createdAt - a.one.createdAt || b.i - a.i).slice(0, LOOP_COMPILES_MAX);
  return { compiles: newest.map(({ one: { createdAt: _createdAt, ...one } }) => one), guards };
}
