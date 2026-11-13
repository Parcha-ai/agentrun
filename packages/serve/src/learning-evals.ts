// An agent's recorded evals (POST and GET /agents/{id}/learning/evals): the result of a held-out test of what the agent
// learned, posted by whoever ran it (a bench, a script, a person), so the console's Learning tab can say how accurate and
// how cheap the learned agent is against the agent by hand, with how many jobs and how sure. A result is only ever what
// was posted: the server never computes one from the agent's own runs (those are the jobs it learned from, never held
// out). Kept in the store's settings under the agent's key, newest first, the latest EVALS_KEPT. Aggregates only.
import { randomUUID } from "node:crypto";
import { type InputIssue, invalid } from "./errors.js";
import type { Store } from "./store/store.js";

/** How many results an agent keeps, newest first. */
export const EVALS_KEPT = 20;
/** The most jobs one test may count. */
export const EVAL_JOBS_MAX = 10_000_000;
/** The longest `source` label. */
export const EVAL_SOURCE_MAX = 120;

/** One side of a test: the learned agent, or the agent by hand. `accuracy` its share of jobs right (0 to 1), `ci` the 95%
 *  interval around it, and `usd_per_job` its mean cost a job (null when the test did not count it). */
export type EvalArm = { accuracy: number; ci: [number, number]; usd_per_job: number | null };
/** One recorded test: `n` held-out jobs, each side's figures, the label of what ran it, the learned revision it tested
 *  (null when not said), when it was measured (as posted, else when recorded) and when it was recorded. */
export type LearningEval = { id: string; source: string; n: number; learned: EvalArm; by_hand: EvalArm; learned_revision: string | null; measured_at: string; recorded_at: string };

const FIELDS = ["source", "n", "learned", "by_hand", "learned_revision", "measured_at"];
const ARM_FIELDS = ["accuracy", "ci", "usd_per_job"];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const share = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** One side's figures from `body[field]`, its problems added to `issues`. */
function armOf(value: unknown, field: string, issues: InputIssue[]): EvalArm | undefined {
  if (!isObject(value)) return void issues.push({ field, reason: "missing", message: `${field} is an object: {accuracy, ci, usd_per_job}` });
  for (const key of Object.keys(value)) if (!ARM_FIELDS.includes(key)) issues.push({ field: `${field}.${key}`, reason: "unknown", message: `${field} takes ${ARM_FIELDS.join(", ")}` });
  const { accuracy, ci, usd_per_job: usd = null } = value;
  const before = issues.length;
  if (!share(accuracy)) issues.push({ field: `${field}.accuracy`, reason: "invalid", message: `${field}.accuracy is a share from 0 to 1`, example: 0.94 });
  const pair = Array.isArray(ci) && ci.length === 2 && share(ci[0]) && share(ci[1]) ? (ci as [number, number]) : null;
  if (!pair) issues.push({ field: `${field}.ci`, reason: "invalid", message: `${field}.ci is the 95% interval, [low, high], each from 0 to 1`, example: [0.91, 0.96] });
  else if (share(accuracy) && !(pair[0] <= (accuracy as number) && (accuracy as number) <= pair[1])) issues.push({ field: `${field}.ci`, reason: "invalid", message: `${field}.ci holds ${field}.accuracy: low <= accuracy <= high` });
  if (!(usd === null || (typeof usd === "number" && Number.isFinite(usd) && usd >= 0))) issues.push({ field: `${field}.usd_per_job`, reason: "invalid", message: `${field}.usd_per_job is a dollar figure, 0 or more, or null` });
  return issues.length > before ? undefined : { accuracy: accuracy as number, ci: [pair![0], pair![1]], usd_per_job: usd as number | null };
}

/** A posted result, checked: each field that is missing or wrong is 422 input_invalid by field, and nothing is kept. */
export function evalOf(body: unknown, now: Date): LearningEval {
  if (!isObject(body)) throw invalid([{ field: "body", reason: "invalid", message: "the body is a JSON object" }]);
  const issues: InputIssue[] = [];
  for (const key of Object.keys(body)) if (!FIELDS.includes(key)) issues.push({ field: key, reason: "unknown", message: `the body takes ${FIELDS.join(", ")}` });
  const { source, n, learned_revision: revision = null, measured_at: measured } = body;
  if (typeof source !== "string" || !source.trim() || source.length > EVAL_SOURCE_MAX || /[\u0000-\u001f\u007f]/.test(source)) issues.push({ field: "source", reason: "invalid", message: `source names what ran the test, in one line of at most ${EVAL_SOURCE_MAX} characters`, example: "invoice bench, sealed test" });
  if (!(Number.isInteger(n) && (n as number) >= 1 && (n as number) <= EVAL_JOBS_MAX)) issues.push({ field: "n", reason: "invalid", message: `n is the held-out jobs counted, a whole number from 1 to ${EVAL_JOBS_MAX}`, example: 200 });
  const learned = armOf(body.learned, "learned", issues);
  const byHand = armOf(body.by_hand, "by_hand", issues);
  if (!(revision === null || (typeof revision === "string" && /^[0-9a-f]{7,64}$/.test(revision)))) issues.push({ field: "learned_revision", reason: "invalid", message: "learned_revision is the learning folder's commit it tested (7 to 64 hex characters), or null" });
  const at = measured === undefined ? now : typeof measured === "string" ? new Date(measured) : new Date(NaN);
  if (Number.isNaN(at.getTime())) issues.push({ field: "measured_at", reason: "invalid", message: "measured_at is an ISO 8601 time", example: "2026-11-13T04:00:00Z" });
  if (issues.length) throw invalid(issues);
  return { id: `eval_${randomUUID()}`, source: (source as string).trim(), n: n as number, learned: learned!, by_hand: byHand!, learned_revision: revision as string | null, measured_at: at.toISOString(), recorded_at: now.toISOString() };
}

const keyOf = (agentId: string) => `learning.evals.${agentId}`;
const listOf = (value: unknown): LearningEval[] => (Array.isArray(value) ? (value as LearningEval[]) : []);

/** Agent `agentId`'s results, newest recorded first. */
export async function evalsOf(store: Store, agentId: string): Promise<LearningEval[]> {
  return listOf(await store.settings.get(keyOf(agentId)));
}

/** Keeps `result` first in agent `agentId`'s results, the latest EVALS_KEPT kept: a compare-and-set, so of two posts at
 *  once neither is lost. */
export async function recordEval(store: Store, agentId: string, result: LearningEval): Promise<void> {
  const key = keyOf(agentId);
  for (;;) {
    const was = await store.settings.get(key);
    const next = [result, ...listOf(was)].slice(0, EVALS_KEPT);
    // putIfAbsent answers what the key holds after: ours (a new id, so no other list equals it) unless another post won.
    const kept = was === undefined ? JSON.stringify(await store.settings.putIfAbsent(key, next)) === JSON.stringify(next) : await store.settings.replaceIf(key, was, next);
    if (kept) return;
  }
}
