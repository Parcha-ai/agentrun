// Promotion by replay (champion/challenger): a learned workflow's new revision (a new digest) serves a run first only once
// a replay of it on the agent's last graded inputs answers within PROMOTE_BAR of the agent's own answers on the same
// inputs. Grades are what a person or an eval said of a run (PUT /runs/{id}/grade): right or wrong, and the answer's
// expected fields when they know them. A replay runs the workflow alone on a graded run's recorded input (a run of its own,
// at workflow cost, runner/promotion.ts); a step it hands back on counts as the agent's recorded answer for that input,
// never as a failure (October's lesson: escalation is the workflow knowing its limits). This module is the arithmetic and
// the two records the store keeps (the agent's grades, its workflows' promotion records), over the settings table; the
// orchestration is runner/promotion.ts, the threshold refit learn/refit.ts.
import type { GuardRow } from "../learned-nodes.js";
import type { RunPath } from "../learning-cost.js";
import type { Settings } from "../store/store.js";
import { answerJson } from "../answer-json.js";

/** How many of the agent's newest graded inputs a replay runs on. */
export const REPLAY_INPUTS = 20;
/** The fewest graded inputs a replay runs on: with fewer, a workflow is promoted on its passing dry run, as before. */
export const REPLAY_MIN = 5;
/** How far below the agent path's accuracy on the same inputs a workflow may be and still serve: 2 points. */
export const PROMOTE_BAR = 0.02;
/** A serving revision's thresholds are refit at most once per this many graded runs it served. */
export const REFIT_EVERY = 20;
/** How many grades, and how many promotion records, an agent keeps (newest kept). */
export const GRADES_KEPT = 500;
export const PROMOTIONS_KEPT = 200;

export const GRADE_SOURCES = ["feedback", "eval"] as const;
export type GradeSource = (typeof GRADE_SOURCES)[number];

/** One graded run: whether its answer was right (`correct`), the answer's expected fields when the grader knows them
 *  (`expected`: a replay's answer is right when its JSON holds each of them), who said so, and, read from the run's record
 *  when it was graded, the path it took and the learned workflow and digest that served it. */
export interface Grade {
  readonly run: string;
  readonly correct: boolean;
  readonly expected?: Readonly<Record<string, unknown>>;
  readonly source: GradeSource;
  readonly at: string;
  readonly path: RunPath;
  readonly workflow?: string;
  readonly digest?: string;
  /** Its place among the agent's grades, one more than the grade put before it (a re-grade takes a new one): a cursor a
   *  serving digest's check counts new grades from (PromotionRecord.checked) that the GRADES_KEPT trim never moves back. */
  readonly seq?: number;
}

/** What a replay says, the shape the promotion record keeps (SPEC: replay {n, agree, agent_acc, wf_acc, delta}):
 *  `n` inputs; `agree`, how many the workflow answered alone with the agent's recorded answer; `agent_acc`, the agent's
 *  recorded answers' accuracy; `wf_acc`, the workflow's, a hand-back counting as the agent's answer; `delta` = wf_acc -
 *  agent_acc; `handed_back`, how many it handed back. Accuracies to 1e-4. */
export interface ReplayScore {
  readonly n: number;
  readonly agree: number;
  readonly agent_acc: number;
  readonly wf_acc: number;
  readonly delta: number;
  readonly handed_back: number;
}

/** A learned workflow's promotion record at one digest. `decided`: `promote` (it serves first), `hold` (it does not: the
 *  champion, championOf, takes its runs, else the agent, until a new revision), `replaying` (its replay runs, `runs`,
 *  are at work; the champion serves meanwhile, else the agent), or `superseded` (a newer revision, `superseded_by`, came
 *  while it replayed: one challenger at a time, so its replay runs were cancelled and it never serves). `source`: `replay` (decided on its replay), `dry_run` (fewer than REPLAY_MIN graded inputs: promoted on
 *  its passing dry run), `refit` (a threshold refit wrote this revision, decided on the rows it was fit on), `graded` (a
 *  serving revision's graded runs fell below the bar: held). `replay`: the numbers it was decided on, with the graded runs
 *  replayed (`of`), what its replay runs cost (`cost_usd`, null when one's is unknown) and how many of its inputs were
 *  skipped (`skipped_write`: each needed a write the graded run's recording does not have, learn/replay-calls.ts; never
 *  run, never scored). `refit`: the guards a refit
 *  changed. `checked`: the newest grade (its seq) the last refit check read (refits run once per REFIT_EVERY more graded runs
 *  it served, counted by seq: a count of the grades kept stalls once the GRADES_KEPT trim holds it). */
export interface PromotionRecord {
  readonly workflow: string;
  readonly digest: string;
  readonly at: string;
  readonly decided: "promote" | "hold" | "replaying" | "superseded";
  readonly source: "replay" | "dry_run" | "refit" | "graded";
  readonly reason: string;
  readonly replay?: ReplayScore & { readonly of: readonly string[]; readonly cost_usd?: number | null; readonly skipped_write?: number };
  readonly runs?: readonly string[];
  /** A replaying record's graded runs, one per `runs` entry in order: the input each reserved replay run replays, so a
   *  launch interrupted after the reservation is finished by a later claim (runner/promotion.ts relaunch). */
  readonly inputs?: readonly string[];
  readonly refit?:{ readonly from: string; readonly guards: readonly RefitGuard[] };
  readonly checked?: number;
  /** A superseded revision's newer one: the digest whose claim cancelled its replay. */
  readonly superseded_by?: string;
  /** The learning commit whose workflows/<workflow>/workflow.json is this digest's text: the seed of the claim that
   *  recorded it, or a refit's own commit. What the digest serves from as the champion (championOf) once a newer revision
   *  is on the folder's main. */
  readonly commit?: string;
}

/** One guard a refit changed: its step, its threshold before and after, and its new fit when one was fit. */
export interface RefitGuard {
  readonly node: string;
  readonly was: number;
  readonly threshold: number;
  readonly fit?: { readonly w: readonly number[]; readonly b: number; readonly n: number; readonly fitted_at: string };
}

export const gradesKey = (agentId: string): string => `learning.grades.${agentId}`;
export const promotionsKey = (agentId: string): string => `learning.promotions.${agentId}`;

type Kept<T> = { readonly v: 1; readonly items: readonly T[] };
const itemsOf = <T>(value: unknown): T[] => (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items) ? [...((value as Kept<T>).items)] : []);

/** `update` over the list kept under `key`, compare-and-set so two writers never lose one's change; the list after. */
async function updateKept<T>(settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, key: string, update: (items: T[]) => T[]): Promise<T[]> {
  for (let tries = 0; tries < 20; tries++) {
    const was = await settings.get(key);
    const items = update(itemsOf<T>(was));
    const value: Kept<T> = { v: 1, items };
    if (was === undefined) {
      const saved = await settings.putIfAbsent(key, value);
      if (JSON.stringify(saved) === JSON.stringify(value)) return items;
      continue;
    }
    if (await settings.replaceIf(key, was, value)) return items;
  }
  throw new Error(`${key} kept changing under this write; try again`);
}

/** The agent's grades, oldest first. */
export const gradesOf = async (settings: Pick<Settings, "get">, agentId: string): Promise<Grade[]> => itemsOf<Grade>(await settings.get(gradesKey(agentId)));

/** Keeps `grade`, in place of any earlier grade of the same run, the newest GRADES_KEPT kept, at the next `seq`. */
export const putGrade = async (settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, agentId: string, grade: Grade): Promise<Grade> => {
  let kept = grade;
  await updateKept<Grade>(settings, gradesKey(agentId), (items) => {
    kept = { ...grade, seq: Math.max(0, ...items.map((one) => one.seq ?? 0)) + 1 };
    return [...items.filter((one) => one.run !== grade.run), kept].slice(-GRADES_KEPT);
  });
  return kept;
};

/** The agent's promotion records, oldest first. */
export const promotionsOf = async (settings: Pick<Settings, "get">, agentId: string): Promise<PromotionRecord[]> => itemsOf<PromotionRecord>(await settings.get(promotionsKey(agentId)));

/** The newest record of `workflow` at `digest`, or undefined. */
export const promotionOf = (records: readonly PromotionRecord[], workflow: string, digest: string): PromotionRecord | undefined =>
  records.findLast((one) => one.workflow === workflow && one.digest === digest);

/** The champion of `workflow`: the newest record of the digest promoted last (a digest's place is its first promote
 *  record's), while that digest's newest record still says promote. A newer revision replaying or held never stops it; a
 *  wrong served grade asks for a revision and never stops it; it stops when a newer revision's replay promotes that one
 *  (then the champion), or its own graded runs hold it (source graded: no champion until a revision is promoted). The
 *  money rule stops it on its own (runner/workflow-first.ts). Undefined: none. */
export function championOf(records: readonly PromotionRecord[], workflow: string): PromotionRecord | undefined {
  const seen = new Set<string>();
  let last: string | undefined;
  for (const one of records) {
    if (one.workflow !== workflow || one.decided !== "promote" || seen.has(one.digest)) continue;
    seen.add(one.digest);
    last = one.digest;
  }
  const now = last === undefined ? undefined : promotionOf(records, workflow, last);
  return now?.decided === "promote" ? now : undefined;
}

/** The revisions of `workflow` other than `digest` whose newest record still says replaying, newest first: at most one
 *  once each new revision supersedes the one replaying (runner/promotion.ts). */
export function replayingOf(records: readonly PromotionRecord[], workflow: string, digest: string | null): PromotionRecord[] {
  const out: PromotionRecord[] = [];
  for (const one of [...records].reverse()) {
    if (one.workflow !== workflow || one.digest === digest || out.some((seen) => seen.digest === one.digest)) continue;
    if (promotionOf(records, workflow, one.digest) === one && one.decided === "replaying") out.push(one);
  }
  return out;
}

/** What each learned workflow with a record serves, by name: `digest`, its champion's (championOf; null: none serves,
 *  the agent takes its runs), and `replaying`, the revision other than it whose replay is at work (null: none; a
 *  superseded one's replay was cancelled, never at work). What the promotions list says beside the records
 *  (GET /agents/{id}/learning/promotions). */
export function servingOf(records: readonly PromotionRecord[]): { workflow: string; digest: string | null; replaying: string | null }[] {
  const names = [...new Set(records.map((one) => one.workflow))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((workflow) => {
    const digest = championOf(records, workflow)?.digest ?? null;
    return { workflow, digest, replaying: replayingOf(records, workflow, digest)[0]?.digest ?? null };
  });
}

/** What a guarded promotion write did: `won`, whether this write kept its record (else `still` did not hold when it
 *  wrote: another claim's decision came first); `record`, the newest record of its workflow at its digest after (the one
 *  written when won, else the one there, undefined when none). A claim acts on a decision (starts replay runs, refits,
 *  cancels) only when it won the write: the loser reads the winner's record, never its turn to act. */
export type Recorded = { readonly record: PromotionRecord | undefined; readonly won: boolean };

/** Keeps `record` as the newest of its workflow at its digest, when `still` holds of the one there now (none: undefined)
 *  and of every record kept (`items`: a check across revisions, one challenger at a time, in the same guarded write): so
 *  of two claims deciding at once only the first decision is kept, and only its claim acts on it (Recorded.won). */
export async function recordPromotion(settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, agentId: string, record: PromotionRecord, still: (now: PromotionRecord | undefined, items: readonly PromotionRecord[]) => boolean): Promise<Recorded> {
  let out: Recorded = { record, won: true };
  await updateKept<PromotionRecord>(settings, promotionsKey(agentId), (items) => {
    const now = promotionOf(items, record.workflow, record.digest);
    if (!still(now, items)) {
      out = { record: now, won: false };
      return items;
    }
    out = { record, won: true };
    return trimPromotions([...items, record]);
  });
  return out;
}

/** The newest PROMOTIONS_KEPT records, in order, never dropping a champion (championOf): each workflow's champion keeps
 *  its first promote record (its place) and its newest, however many newer revisions replayed or were held since. */
export function trimPromotions(items: readonly PromotionRecord[]): PromotionRecord[] {
  if (items.length <= PROMOTIONS_KEPT) return [...items];
  const keep = new Set<number>();
  for (const workflow of new Set(items.map((one) => one.workflow))) {
    const champion = championOf(items, workflow);
    if (!champion) continue;
    keep.add(items.lastIndexOf(champion));
    keep.add(items.findIndex((one) => one.workflow === workflow && one.digest === champion.digest && one.decided === "promote"));
  }
  for (let i = items.length - 1, room = PROMOTIONS_KEPT - keep.size; i >= 0 && room > 0; i--) {
    if (keep.has(i)) continue;
    keep.add(i);
    room -= 1;
  }
  return items.filter((_, i) => keep.has(i));
}

/** One replayed input: the graded run it replays (`of`), the agent's recorded answer and its grade, and what the workflow
 *  did on it: answered alone (`answer`), handed back (it escalated: an escalate node or a guard), or failed (a step failed,
 *  on a credential or tool the replay lacked among them, or its output off its schema; no workflow, a stale digest, a run
 *  that did not end completed); with its guard rows, read record-only (recordOnly) so each step's p is known. A failed
 *  row is no evidence either way (replayScore leaves it out): the replay ran without what the run it replays had. A
 *  skipped one (`skipped_write`) is none either: its workflow stopped at a write the graded run's recording does not have,
 *  which a replay never runs (learn/replay-calls.ts). */
export interface ReplayRow {
  readonly of: string;
  readonly recorded: { readonly answer: string | null; readonly correct: boolean; readonly expected?: Readonly<Record<string, unknown>> };
  readonly outcome: "answered" | "handed_back" | "failed" | "skipped_write";
  readonly answer: string | null;
  readonly guards: readonly GuardRow[];
}

/** An answer's value: its text as JSON when it is JSON, else its last fenced json block, else its trimmed text. */
function valueOf(answer: string): unknown {
  const text = answer.trim();
  try {
    return JSON.parse(text);
  } catch {
    const block = answerJson(text);
    return "value" in block ? block.value : text;
  }
}

/** JSON values equal as values: keys in any order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((one, i) => same(one, (b as unknown[])[i]));
  const [ka, kb] = [Object.keys(a as object), Object.keys(b as object)];
  return ka.length === kb.length && ka.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Whether two answers say the same: equal as JSON values, else as trimmed text. */
export const sameAnswer = (a: string | null, b: string | null): boolean => a !== null && b !== null && same(valueOf(a), valueOf(b));

/** Whether the workflow's `answer` to a graded input is right: with the grade's expected fields, when its JSON holds each
 *  of them (or, one field expected, when the answer is that field's text: a workflow whose output is one text field
 *  answers with that text, learned-workflow.ts learnedOutput); else when it says what the agent's graded answer said,
 *  that answer's grade. An answer that differs from the agent's when the agent's was wrong is counted wrong: nothing says
 *  it is right (a replay never flatters the workflow). */
export function answerCorrect(answer: string | null, recorded: ReplayRow["recorded"]): boolean {
  if (answer === null) return false;
  if (recorded.expected) {
    const value = valueOf(answer);
    const fields = Object.values(recorded.expected);
    if (fields.length === 1 && typeof fields[0] === "string" && answer.trim() === fields[0].trim()) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.entries(recorded.expected).every(([key, want]) => same((value as Record<string, unknown>)[key], want));
  }
  return sameAnswer(answer, recorded.answer) ? recorded.correct : false;
}

/** The thresholds a workflow's guards serve at, by step label (the guard rows' `node`): every node of the workflow's JSON
 *  with a `guard` and a `label`. */
export function thresholdsOf(workflowText: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    walkGuards(JSON.parse(workflowText), (label, guard) => {
      if (typeof guard.threshold === "number") out.set(label, guard.threshold);
    });
  } catch {
    // Not JSON: no guards to read.
  }
  return out;
}

/** Each node of a workflow document with a guard, by its label as the DSL names its step when it runs, in document order:
 *  a step of a child workflow (a `workflow` node's `workflow`) as `parent/child`, as the DSL prefixes its events and its
 *  guard rows (scopeDepsToChild), so a nested guard's serving threshold and its refit read the rows it made. */
export function walkGuards(node: unknown, visit: (label: string, guard: Record<string, unknown>) => void, prefix = ""): void {
  if (Array.isArray(node)) {
    for (const one of node) walkGuards(one, visit, prefix);
    return;
  }
  if (!node || typeof node !== "object") return;
  const object = node as Record<string, unknown>;
  if (typeof object.label === "string" && object.guard && typeof object.guard === "object" && !Array.isArray(object.guard)) visit(`${prefix}${object.label}`, object.guard as Record<string, unknown>);
  for (const [key, value] of Object.entries(object)) {
    if (key === "guard") continue;
    const child = key === "workflow" && object.node === "workflow" && typeof object.label === "string";
    walkGuards(value, visit, child ? `${prefix}${object.label}/` : prefix);
  }
}

/** The threshold a replay's guards read at: the least the DSL takes (a threshold is in (0, 1), exclusive), so a guard
 *  hands back only when p is null (a signal it reads is missing) or 0. */
export const RECORD_ONLY_THRESHOLD = 1e-9;

/** A workflow's text with every guard's threshold at RECORD_ONLY_THRESHOLD: each guard still reads its signals and
 *  records its row. What a replay runs, so every step's p is known for the refit and the serving thresholds are applied
 *  after (replayScore). The text unchanged when it has no guard. */
export function recordOnly(workflowText: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(workflowText);
  } catch {
    return workflowText;
  }
  let any = false;
  walkGuards(doc, (_label, guard) => {
    guard.threshold = RECORD_ONLY_THRESHOLD;
    any = true;
  });
  return any ? JSON.stringify(doc) : workflowText;
}

/** Whether a replayed input would have been handed back serving at `thresholds` (by step; a step not named keeps its
 *  row's): it did not answer alone, or one of its guards read no p, or a p under its step's threshold. */
export function escalates(row: Pick<ReplayRow, "outcome" | "guards">, thresholds: ReadonlyMap<string, number>): boolean {
  if (row.outcome !== "answered") return true;
  return row.guards.some((guard) => guard.p === null || guard.p < (thresholds.get(guard.node) ?? guard.threshold));
}

const round = (value: number) => Math.round(value * 1e4) / 1e4;

/** The replayed inputs a replay scores: those its workflow answered or handed back, never one it failed on or skipped. */
export const scoredRows = (rows: readonly ReplayRow[]): ReplayRow[] => rows.filter((row) => row.outcome === "answered" || row.outcome === "handed_back");

/** What a replay says at the serving `thresholds`, over the inputs it answered or handed back (scoredRows: a failed or
 *  skipped one is no evidence): each the workflow would have answered alone graded by answerCorrect, each it would have handed back the
 *  agent's recorded answer and grade. */
export function replayScore(all: readonly ReplayRow[], thresholds: ReadonlyMap<string, number>): ReplayScore {
  const rows = scoredRows(all);
  let [agentRight, wfRight, agree, handed] = [0, 0, 0, 0];
  for (const row of rows) {
    if (row.recorded.correct) agentRight += 1;
    if (escalates(row, thresholds)) {
      handed += 1;
      if (row.recorded.correct) wfRight += 1;
      continue;
    }
    if (answerCorrect(row.answer, row.recorded)) wfRight += 1;
    if (sameAnswer(row.answer, row.recorded.answer)) agree += 1;
  }
  const n = rows.length;
  const [agent_acc, wf_acc] = n ? [round(agentRight / n), round(wfRight / n)] : [0, 0];
  return { n, agree, agent_acc, wf_acc, delta: round(wf_acc - agent_acc), handed_back: handed };
}

/** Whether a score clears the bar: the workflow's accuracy at most PROMOTE_BAR under the agent path's. */
export const clears = (score: Pick<ReplayScore, "delta">): boolean => score.delta >= -PROMOTE_BAR - 1e-9;

/** A grade as the API answers it (PUT /runs/{id}/grade). */
export const gradeView = (grade: Grade) => ({
  run_id: grade.run, correct: grade.correct, ...(grade.expected ? { expected: grade.expected } : {}), source: grade.source, graded_at: grade.at,
  path: grade.path, workflow: grade.workflow ?? null, workflow_digest: grade.digest ?? null,
});
