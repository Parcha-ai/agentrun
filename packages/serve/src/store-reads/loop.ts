// GET /agents/{id}/learning/loop from the one store: what the console's Learning tab tells of the self-learning loop
// beside the cost series. Each compile turn the agent's runs took (learn/compile.ts: the workflow it wrote, the notes it
// absorbed, each attempt and what the checks refused, the draft's digest and whether that revision serves), and each
// guarded step of its learned workflows (runner/step-guard.ts rows on a run's metrics.guards): its signal and threshold,
// how often it handed the run back, and each run's p, with the run's grade when the workflow's own answer was graded.
// Aggregates and the checks' own words only: no input, no answer.
import { FINAL_STATES, type Store } from "../store/store.js";
import type { GuardRow } from "../learned-nodes.js";
import { gradesOf, promotionsOf } from "../learn/promote.js";
import { promotedOf } from "../learn/compile.js";

/** How many compile turns the read gives, the newest. */
export const LOOP_COMPILES_MAX = 50;
/** How many runs' p a guarded step gives, its newest. */
export const LOOP_POINTS_MAX = 200;

/** One compile turn of a run: `errors` its draft's when none passed (never silent). */
export type LoopCompile = {
  run_id: string;
  at: string;
  workflow: string | null;
  from_notes: string[];
  attempts: { ok: boolean; errors: string[] }[];
  digest: string | null;
  promoted: boolean | null;
  draft_errors: string[];
};
/** One run's guard outcome on a step: its p (null when a signal was missing: it handed back), whether it handed back,
 *  and, when the run's answer was the workflow's own and it was graded, whether that was right. */
export type LoopPoint = { run_id: string; p: number | null; escalated: boolean; correct: boolean | null };
/** One guarded step of one revision of a learned workflow, over the runs that ran it (served and replayed). */
export type LoopGuard = {
  workflow: string;
  digest: string;
  node: string;
  signal: GuardRow["signal"];
  threshold: number;
  runs: number;
  escalated: number;
  points: LoopPoint[];
};

const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((one): one is string => typeof one === "string") : []);
const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

/** A run's guard rows as its record keeps them (metrics.guards), read as untrusted: a row out of shape is left out. */
function guardRowsOf(metrics: unknown): GuardRow[] {
  const rows = (metrics as { guards?: unknown } | null | undefined)?.guards;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is GuardRow => {
    const r = row as Partial<GuardRow> | null;
    return !!r && typeof r.node === "string" && (r.signal === "self" || r.signal === "jev" || r.signal === "both") && typeof r.threshold === "number" && typeof r.escalated === "boolean" && (r.p === null || typeof r.p === "number");
  });
}

/** The agent's compile turns (newest first, LOOP_COMPILES_MAX) and its learned workflows' guarded steps, over its ended
 *  runs (not imported, not archived). A compile's `promoted` is its revision's promotion as the records say now (null
 *  while undecided). A step's `correct` is the run's grade only on a run its workflow answered alone (path `workflow`): a
 *  hand-back's answer was the agent's, and a replay run is never graded. */
export async function agentLoopOverStore(store: Store, agentId: string): Promise<{ compiles: LoopCompile[]; guards: LoopGuard[] }> {
  const ended = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId && FINAL_STATES.includes(run.state) && !run.importedFrom && run.archivedAt === null).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const [grades, promotions] = await Promise.all([gradesOf(store.settings, agentId).catch(() => []), promotionsOf(store.settings, agentId).catch(() => [])]);
  const graded = new Map(grades.map((grade) => [grade.run, grade.correct]));
  const compiles: LoopCompile[] = [];
  const steps = new Map<string, LoopGuard>();
  for (const run of ended) {
    const metrics = run.metrics as { path?: unknown; workflow?: unknown; workflow_digest?: unknown } | null | undefined;
    const workflow = typeof metrics?.workflow === "string" ? metrics.workflow : null;
    const digest = typeof metrics?.workflow_digest === "string" ? metrics.workflow_digest : null;
    if (workflow && digest) {
      const alone = metrics?.path === "workflow";
      for (const row of guardRowsOf(run.metrics)) {
        const key = `${workflow}\u0000${digest}\u0000${row.node}`;
        const step = steps.get(key) ?? { workflow, digest, node: row.node, signal: row.signal, threshold: row.threshold, runs: 0, escalated: 0, points: [] };
        step.runs += 1;
        if (row.escalated) step.escalated += 1;
        step.points.push({ run_id: run.id, p: row.p === null ? null : round4(row.p), escalated: row.escalated, correct: alone ? (graded.get(run.id) ?? null) : null });
        steps.set(key, step);
      }
    }
    const kept = await store.learning.proposal(run.id).catch(() => undefined);
    const row = (kept?.proposal ?? null) as { compiled?: unknown; draft_errors?: unknown } | null;
    if (!kept || !row) continue;
    const errors = texts(row.draft_errors);
    const record = row.compiled as { workflow?: unknown; from_notes?: unknown; attempts?: unknown; digest?: unknown } | undefined;
    const named = record && typeof record === "object" && typeof record.workflow === "string" ? record : undefined;
    if (!named && !errors.length) continue;
    const attempts = Array.isArray(named?.attempts) ? named.attempts.filter((one) => one && typeof one === "object" && typeof (one as { ok?: unknown }).ok === "boolean").map((one) => ({ ok: (one as { ok: boolean }).ok, errors: texts((one as { errors?: unknown }).errors) })) : [];
    const kept16 = typeof named?.digest === "string" && /^[0-9a-f]{16}$/.test(named.digest) ? named.digest : null;
    compiles.push({
      run_id: run.id, at: new Date(kept.createdAt).toISOString(), workflow: named ? (named.workflow as string) : null, from_notes: texts(named?.from_notes), attempts,
      digest: kept16, promoted: named && kept16 ? (promotedOf(promotions, named.workflow as string, kept16) ?? null) : null, draft_errors: errors,
    });
  }
  const guards = [...steps.values()].map((step) => ({ ...step, points: step.points.slice(-LOOP_POINTS_MAX) }));
  return { compiles: compiles.reverse().slice(0, LOOP_COMPILES_MAX), guards };
}
