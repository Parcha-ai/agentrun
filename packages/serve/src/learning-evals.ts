// An agent's eval records (POST and GET /agents/{id}/learning/evals): the counts of a held-out test of what the agent
// learned, posted by whoever ran it (a bench, a script, a person): `n` jobs it never learned from, `correct` of them right,
// the cost a task with learning and by hand, where the labels came from and the learned revision it tested. The server
// computes the accuracy and its 95% Wilson interval from the counts (a caller never sends either), so the console's
// Learning tab can say how accurate and how cheap the learned agent is, with how many jobs and how sure. A record is only
// ever what was posted: the server never computes one from the agent's own runs (the jobs it learned from, never held
// out). Append-only, the latest first and the one shown, the latest EVALS_KEPT kept in the store's settings under the
// agent's key. Aggregates only: no rows, no inputs.
import { randomUUID } from "node:crypto";
import { type InputIssue, invalid } from "./errors.js";
import type { Store } from "./store/store.js";

/** How many records an agent keeps, newest first. */
export const EVALS_KEPT = 20;
/** The most jobs one test may count. */
export const EVAL_JOBS_MAX = 10_000_000;
/** The longest `name` and `label_source`. */
export const EVAL_TEXT_MAX = 200;

/** One record: what was posted (`name`, `label_source`, the counts, each side's cost a task, the learned revision), the
 *  server's `accuracy` (correct / n) and `ci` (its 95% Wilson interval), each to four places, and when it was recorded. */
export type LearningEval = {
  id: string;
  name: string;
  label_source: string | null;
  n: number;
  correct: number;
  accuracy: number;
  ci: [number, number];
  cost_per_task_usd: number | null;
  baseline_cost_per_task_usd: number | null;
  learned_revision: string | null;
  recorded_at: string;
};

const FIELDS = ["name", "label_source", "n", "correct", "cost_per_task_usd", "baseline_cost_per_task_usd", "learned_revision"];
/** z for a two-sided 95% interval. */
const Z95 = 1.959963984540054;
const places = (value: number) => Math.round(value * 1e4) / 1e4;

/** The 95% Wilson score interval of `correct` right of `n`, [low, high], each from 0 to 1, to four places: unlike the
 *  normal approximation it holds at 0 and at n right and with few jobs. */
export function wilsonOf(n: number, correct: number): [number, number] {
  const p = correct / n;
  const z2 = Z95 * Z95;
  const over = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / over;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / over;
  return [places(Math.max(0, centre - half)), places(Math.min(1, centre + half))];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const oneLine = (value: unknown) => typeof value === "string" && !!value.trim() && value.length <= EVAL_TEXT_MAX && !/[\u0000-\u001f\u007f]/.test(value);
const whole = (value: unknown, least: number, most: number) => Number.isInteger(value) && (value as number) >= least && (value as number) <= most;
const dollars = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

/** A posted record, checked for its shape only: each field that is missing or wrong is 422 input_invalid by field, and
 *  nothing is kept. */
export function evalOf(body: unknown, now: Date): LearningEval {
  if (!isObject(body)) throw invalid([{ field: "body", reason: "invalid", message: "the body is a JSON object" }]);
  const issues: InputIssue[] = [];
  for (const key of Object.keys(body)) {
    const why = key === "accuracy" || key === "ci" ? "the server computes accuracy and ci from n and correct" : `the body takes ${FIELDS.join(", ")}`;
    if (!FIELDS.includes(key)) issues.push({ field: key, reason: "unknown", message: why });
  }
  const { name, label_source: source = null, n, correct, cost_per_task_usd: cost = null, baseline_cost_per_task_usd: baseline = null, learned_revision: revision = null } = body;
  if (!oneLine(name)) issues.push({ field: "name", reason: "invalid", message: `name says what ran the test, in one line of at most ${EVAL_TEXT_MAX} characters`, example: "invoice bench, sealed test" });
  if (!(source === null || oneLine(source))) issues.push({ field: "label_source", reason: "invalid", message: `label_source says where the right answers came from, in one line of at most ${EVAL_TEXT_MAX} characters, or null`, example: "teacher labels, 87% strict vs people" });
  const jobs = whole(n, 1, EVAL_JOBS_MAX);
  if (!jobs) issues.push({ field: "n", reason: "invalid", message: `n is the held-out jobs counted, a whole number from 1 to ${EVAL_JOBS_MAX}`, example: 200 });
  if (!whole(correct, 0, jobs ? (n as number) : EVAL_JOBS_MAX)) issues.push({ field: "correct", reason: "invalid", message: "correct is how many of the n jobs it got right, a whole number from 0 to n", example: 188 });
  if (!dollars(cost)) issues.push({ field: "cost_per_task_usd", reason: "invalid", message: "cost_per_task_usd is the mean cost a task with learning, in dollars, 0 or more, or null" });
  if (!dollars(baseline)) issues.push({ field: "baseline_cost_per_task_usd", reason: "invalid", message: "baseline_cost_per_task_usd is the mean cost a task by hand, in dollars, 0 or more, or null" });
  if (!(revision === null || (typeof revision === "string" && /^[0-9a-f]{7,64}$/.test(revision)))) issues.push({ field: "learned_revision", reason: "invalid", message: "learned_revision is the learning folder's commit it tested (7 to 64 hex characters), or null" });
  if (issues.length) throw invalid(issues);
  const [jobsN, right] = [n as number, correct as number];
  return {
    id: `eval_${randomUUID()}`,
    name: (name as string).trim(),
    label_source: source === null ? null : (source as string).trim(),
    n: jobsN,
    correct: right,
    accuracy: places(right / jobsN),
    ci: wilsonOf(jobsN, right),
    cost_per_task_usd: cost as number | null,
    baseline_cost_per_task_usd: baseline as number | null,
    learned_revision: revision as string | null,
    recorded_at: now.toISOString(),
  };
}

const keyOf = (agentId: string) => `learning.evals.${agentId}`;
const listOf = (value: unknown): LearningEval[] => (Array.isArray(value) ? (value as LearningEval[]) : []);

/** Agent `agentId`'s records, newest recorded first. */
export async function evalsOf(store: Store, agentId: string): Promise<LearningEval[]> {
  return listOf(await store.settings.get(keyOf(agentId)));
}

/** Appends `record` first in agent `agentId`'s records, the latest EVALS_KEPT kept: a compare-and-set, so of two posts at
 *  once neither is lost. */
export async function recordEval(store: Store, agentId: string, record: LearningEval): Promise<void> {
  const key = keyOf(agentId);
  for (;;) {
    const was = await store.settings.get(key);
    const next = [record, ...listOf(was)].slice(0, EVALS_KEPT);
    // putIfAbsent answers what the key holds after: ours (a new id, so no other list equals it) unless another post won.
    const kept = was === undefined ? JSON.stringify(await store.settings.putIfAbsent(key, next)) === JSON.stringify(next) : await store.settings.replaceIf(key, was, next);
    if (kept) return;
  }
}
