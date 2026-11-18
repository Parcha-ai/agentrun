// Promotion (champion/challenger): a learned workflow's new revision (a new digest) serves a run first only once its one
// check passes: replayed on the inputs of the agent's last compile_after completed runs, of those it ran on it answered
// at least alone_min alone, and at least agree_min of those said what the agent's own recorded answer said (sameAnswer,
// checkPasses; the bar is the agent definition's, learning-setting.ts). No grade is read for it. A replay runs the
// workflow alone on a run's recorded input (a run of its own, at workflow cost, runner/promotion.ts); a step it hands
// back on is not an answer alone. This module is the arithmetic and the two records the store keeps (the agent's grades,
// its workflows' promotion records), over the settings table; the orchestration is runner/promotion.ts. Grades are what
// a person or an eval said of a run (PUT /runs/{id}/grade).
import type { RunPath } from "../learning-cost.js";
import type { FeedbackRound, OpenedRound } from "../runner/feedback-round.js";
import type { Settings } from "../store/store.js";
import { answerJson } from "../answer-json.js";
import type { Skipped } from "./replay-calls.js";
import type { ReplayOutcome } from "../runner/workflow-first.js";

/** How many grades, and how many promotion records, an agent keeps (newest kept). */
export const GRADES_KEPT = 500;
export const PROMOTIONS_KEPT = 200;

/** The most characters a grade's words (`label`) may hold, and the most of them and of an answer a compile ask shows. */
export const LABEL_MAX = 4_000;

export const GRADE_SOURCES =["feedback", "eval"] as const;
export type GradeSource = (typeof GRADE_SOURCES)[number];

/** One graded run: whether its answer was right (`correct`), the answer's expected fields when the grader knows them
 *  (`expected`), who said so, and, read from the run's record when it was graded, the path it took and the learned
 *  workflow and digest that served it. */
export interface Grade {
  readonly run: string;
  readonly correct: boolean;
  readonly expected?: Readonly<Record<string, unknown>>;
  readonly source: GradeSource;
  readonly at: string;
  readonly path: RunPath;
  readonly workflow?: string;
  readonly digest?: string;
  /** Its place among the agent's grades, one more than the grade put before it (a re-grade takes a new one), that the
   *  GRADES_KEPT trim never moves back: what tells a grade from another given in the same millisecond. */
  readonly seq?: number;
  /** The feedback round the grade opened its run again on, null for none (runner/feedback-round.ts keepGrade). Set only
   *  once the round opened, so a kept grade never names a round that didn't. */
  readonly feedback?: FeedbackRound | null;
  /** The steer command that round opened the run again on (store.runs.reopen's id), set with `feedback`: the run's journal
   *  and that steer's row say how that round stands (runner/feedback-round.ts feedbackStatus), never a clock. Not in the
   *  API's view. */
  readonly feedbackCommand?: number;
}

/** What a replay says, the shape a replay's read keeps (SPEC: replay {n, agree, agent_acc, wf_acc, delta}): `n` inputs;
 *  `agree`, how many the workflow answered alone with the agent's recorded answer; `agent_acc`, the agent's accuracy on
 *  them (1: the agent's own answers are the label); `wf_acc`, the workflow's, a hand-back counting as the agent's answer;
 *  `delta` = wf_acc - agent_acc; `handed_back`, how many it handed back (it answered n - handed_back alone:
 *  answersAlone). Accuracies to 1e-4. */
export interface ReplayScore {
  readonly n: number;
  readonly agree: number;
  readonly agent_acc: number;
  readonly wf_acc: number;
  readonly delta: number;
  readonly handed_back: number;
}

/** Whether a replay answered alone on at least one of its inputs: one that hands back every input would never serve. The
 *  one spelling of it (the compile's held line); the count is n - handed_back. */
export const answersAlone = (score: Pick<ReplayScore, "n" | "handed_back">): boolean => score.handed_back < score.n;

/** A learned workflow's promotion record at one digest. `decided`: `promote` (it serves first), `hold` (it does not: the
 *  champion, championOf, takes its runs, else the agent, until a new revision) or `replaying` (its check's replay runs,
 *  `runs`, are at work; the champion serves meanwhile, else the agent). `check`: the bar it was checked at and the
 *  numbers it was decided on. */
export interface PromotionRecord {
  readonly workflow: string;
  readonly digest: string;
  readonly at: string;
  readonly decided: "promote" | "hold" | "replaying";
  readonly reason: string;
  /** A compiled draft's one check (runner/promotion.ts): its bar while it replays, its numbers once decided. */
  readonly check?: CheckRecord;
  /** A serving revision's audit hold (runner/audit.ts): the rows that held it. A hold with it is the audit's; one without
   *  it, its check's. */
  readonly audit?: AuditHold;
  readonly runs?: readonly string[];
  /** A replaying record's runs, one per `runs` entry in order: the agent run whose input each reserved replay run replays,
   *  so a launch interrupted after the reservation is finished by a later claim (runner/promotion.ts relaunch). */
  readonly inputs?: readonly string[];
  /** The replay's id, minted when it was reserved (a claim's, or a person's POST .../replays) and kept on the record that
   *  decides it: what GET .../replays/{replay_id} reads. */
  readonly replay_id?: string;
  /** A replaying record's launch, chosen once when it was reserved (runner/promotion.ts reserve): every replay run of it,
   *  whoever creates it (the reserving claim or person, or a later claim finishing an interrupted launch), runs at
   *  `revision` from `body` (a run launch body; each run sets its own input, title and replay), handed the per_run MCP
   *  credentials run `handed_from` was handed (a claim's claimed run), else none (an owner's replay). One replay runs on
   *  one set of settings. Never in the promotions read (promotionsShown). */
  readonly launch?: ReplayLaunch;
  /** The learning commit whose workflows/<workflow>/workflow.json is this digest's text: the seed of the claim that
   *  recorded it. What the digest serves from as the champion (championOf) once a newer revision is on the folder's main. */
  readonly commit?: string;
}

/** One audit row a hold was decided on that disagreed: the served run (`served`) and its input, the run whose answer is
 *  the agent's (`run`: the shadow run, else the served run for a grade), the agent's answer (`agent`: the shadow's, null
 *  for a grade, which says only that the served answer was wrong) and the served answer (`draft`); `graded`, a row an
 *  owner's grade wrote. Each text cut to CHECK_TEXT_MAX: what the one recompile reads as data. */
export interface AuditDisagreement {
  readonly run: string;
  readonly served: string;
  readonly input: string;
  readonly agent: string | null;
  readonly draft: string | null;
  readonly graded?: true;
}

/** An audit hold (runner/audit.ts): the definition's `hold_window` and `hold_disagree` it was decided at, how many rows
 *  it read (`rows`, at most the window), the disagreeing ones, and `stopped` when it was a second hold within
 *  `stop_window` served runs of the first: no compile is asked, nothing serves again until a new revision lands. */
export interface AuditHold {
  readonly window: number;
  readonly disagree: number;
  readonly rows: number;
  readonly disagreements: readonly AuditDisagreement[];
  readonly stopped?: true;
}

/** The bar a compiled draft's check was started with: the agent definition's loop numbers then (learning-setting.ts), and
 *  which check of the compile it is (`attempt`: 1, the first draft's; 2, the one recompile's, after which it stops). */
export interface CheckBar {
  readonly compile_after: number;
  readonly agree_min: number;
  readonly alone_min: number;
  readonly attempt: 1 | 2;
}

/** One input a check's draft did not agree on: the agent's run (`run`) and its input, the agent's recorded answer
 *  (`agent`), and the draft's answer, or why it handed the input back (`escalated`), or that a step of it failed
 *  (`failed`). Each text cut to CHECK_TEXT_MAX: what a recompile reads as data. */
export interface CheckDisagreement {
  readonly run: string;
  readonly input: string;
  readonly agent: string | null;
  readonly draft?: string;
  readonly escalated?: string;
  readonly failed?: true;
}

/** A check's numbers, once decided: `n` inputs it ran on (a skipped write is none), `agreed` of them answered alone with
 *  the agent's recorded answer (sameAnswer), `alone` answered alone (no escalate, no failed step); the inputs (`of`, the
 *  agent's runs), what its replay runs cost, their outcomes (one per input: a replay run never created by the deadline
 *  failed), how many of its replay runs were never created (`unstarted`, when any), the tools that stopped its skipped
 *  inputs, the inputs it did not agree on, and `stopped` when a recompile's check held it too (nothing compiles again). */
export type CheckRecord = CheckBar & {
  readonly n?: number;
  readonly agreed?: number;
  readonly alone?: number;
  readonly of?: readonly string[];
  readonly cost_usd?: number | null;
  readonly outcomes?: ReplayOutcomes;
  readonly unstarted?: number;
  readonly skipped_tools?: readonly SkippedTool[];
  readonly disagreements?: readonly CheckDisagreement[];
  readonly stopped?: true;
};

/** The most characters of an input or an answer a check's disagreement keeps. */
export const CHECK_TEXT_MAX = 1_200;

/** A check's two shares: `agreement`, of the inputs the draft answered alone those that say what the agent said (0 when
 *  it answered none alone); `alone`, of the inputs it ran on those it answered alone (0 when none ran). */
export const checkShares = (score: { readonly n: number; readonly agreed: number; readonly alone: number }): { agreement: number; alone: number } =>
  ({ agreement: score.alone ? score.agreed / score.alone : 0, alone: score.n ? score.alone / score.n : 0 });

/** Whether a check promotes its draft: agreement at least the bar's agree_min, and alone at least its alone_min. */
export const checkPasses = (score: { readonly n: number; readonly agreed: number; readonly alone: number }, bar: Pick<CheckBar, "agree_min" | "alone_min">): boolean => {
  const shares = checkShares(score);
  return score.n > 0 && score.alone > 0 && shares.agreement >= bar.agree_min - 1e-9 && shares.alone >= bar.alone_min - 1e-9;
};

/** What a replay's runs are launched with (PromotionRecord.launch). */
export interface ReplayLaunch {
  readonly revision: string;
  readonly body: unknown;
  readonly handed_from?: string;
}

/** A tool that stopped a replay's inputs (each a skipped_write row): its catalog name, how many inputs it stopped, and
 *  whether it is an MCP tool its server listed with no readOnlyHint (`no_read_only_hint`: replay may only lack the hint,
 *  not a recording). */
export interface SkippedTool {
  readonly tool: string;
  readonly inputs: number;
  readonly no_read_only_hint: boolean;
}

/** The tools that stopped `rows`' skipped inputs, most inputs first (then by name). */
export function skippedToolsOf(rows: readonly { readonly outcome: ReplayOutcome; readonly skipped?: Skipped }[]): SkippedTool[] {
  const by = new Map<string, { inputs: number; unmarked: boolean }>();
  for (const row of rows) {
    if (row.outcome !== "skipped_write" || !row.skipped) continue;
    const was = by.get(row.skipped.tool) ?? { inputs: 0, unmarked: true };
    by.set(row.skipped.tool, { inputs: was.inputs + 1, unmarked: was.unmarked && row.skipped.unmarked === true });
  }
  return [...by].map(([tool, one]) => ({ tool, inputs: one.inputs, no_read_only_hint: one.unmarked }))
    .sort((a, b) => b.inputs - a.inputs || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
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

/** Marks the kept grade `grade` (its run, given at its `at`, kept at its `seq`) with the feedback round it opened and
 *  that round's steer, in place: its `seq` stays. A newer grade of the run is left as it is, one given in the same
 *  millisecond too (its `seq` is another). The grade, marked. */
export const markGradeRound = async (settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, agentId: string, grade: Grade, opened: OpenedRound): Promise<Grade> => {
  const mark = { feedback: opened.round, feedbackCommand: opened.command };
  await updateKept<Grade>(settings, gradesKey(agentId), (items) => items.map((one) => (one.run === grade.run && one.at === grade.at && one.seq === grade.seq ? { ...one, ...mark } : one)));
  return { ...grade, ...mark };
};

/** The states a promotion record is written in (PromotionRecord.decided). */
const DECIDED: readonly string[] = ["promote", "hold", "replaying"] satisfies readonly PromotionRecord["decided"][];
/** The records of `items` in a state this code writes: one saved in any other is dropped, as if absent (its revision is
 *  checked again). */
const writtenOf = (items: readonly PromotionRecord[]): PromotionRecord[] => items.filter((one) => DECIDED.includes(one?.decided));

/** The agent's promotion records, oldest first: only those in a state this code writes (writtenOf). */
export const promotionsOf = async (settings: Pick<Settings, "get">, agentId: string): Promise<PromotionRecord[]> =>
  writtenOf(itemsOf<PromotionRecord>(await settings.get(promotionsKey(agentId))));

/** The newest record of `workflow` at `digest`, or undefined. */
export const promotionOf = (records: readonly PromotionRecord[], workflow: string, digest: string): PromotionRecord | undefined =>
  records.findLast((one) => one.workflow === workflow && one.digest === digest);

/** The champion of `workflow`: the newest record of the digest promoted last, while that digest's newest record still
 *  says promote. A newer revision replaying or held never stops it; it stops when a newer revision's check promotes that
 *  one (then the champion), or when its own newest record is a hold (a held revision its owner replays, askReplay, that
 *  promotes wins again). The money rule stops it on its own (runner/workflow-first.ts). Undefined: none. */
export function championOf(records: readonly PromotionRecord[], workflow: string): PromotionRecord | undefined {
  const last = lastPromotedOf(records, workflow);
  const now = last === undefined ? undefined : promotionOf(records, workflow, last);
  return now?.decided === "promote" ? now : undefined;
}

/** The newest promotion of `workflow` at `digest`: the promote record that began its newest run of promote records (its
 *  first, or the first after a record of that digest that was not promote: an owner's replay that promoted a held
 *  revision), or undefined when none was ever promoted. Its `at` names that promotion: an audit row keeps the one serving
 *  when its evidence began (learn/audit.ts promoted_at), and the hold rule counts only the rows of the one serving now,
 *  so a digest its owner's replay promotes again after a hold starts on no rows. */
export function promotionStartOf(records: readonly PromotionRecord[], workflow: string, digest: string): PromotionRecord | undefined {
  let start: PromotionRecord | undefined;
  let streak = false;
  for (const one of records) {
    if (one.workflow !== workflow || one.digest !== digest) continue;
    if (one.decided !== "promote") streak = false;
    else if (!streak) [start, streak] = [one, true];
  }
  return start;
}

/** The digest of `workflow` promoted last: the one of its newest promote record. */
function lastPromotedOf(records: readonly PromotionRecord[], workflow: string): string | undefined {
  return records.findLast((one) => one.workflow === workflow && one.decided === "promote")?.digest;
}

/** The revision of `workflow` other than `digest` whose newest record still says replaying, newest first: at most one (one
 *  check at a time, the reservation's guarded write). */
export function replayingOf(records: readonly PromotionRecord[], workflow: string, digest: string | null): PromotionRecord[] {
  const out: PromotionRecord[] = [];
  for (const one of [...records].reverse()) {
    if (one.workflow !== workflow || one.digest === digest || out.some((seen) => seen.digest === one.digest)) continue;
    if (promotionOf(records, workflow, one.digest) === one && one.decided === "replaying") out.push(one);
  }
  return out;
}

/** What each learned workflow with a record serves, by name: `digest`, its champion's (championOf; null: none serves,
 *  the agent takes its runs), and `replaying`, the revision other than it whose check is at work (null: none). What the
 *  promotions list says beside the records (GET /agents/{id}/learning/promotions). */
export function servingOf(records: readonly PromotionRecord[]): { workflow: string; digest: string | null; replaying: string | null }[] {
  const names = [...new Set(records.map((one) => one.workflow))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((workflow) => {
    const digest = championOf(records, workflow)?.digest ?? null;
    return { workflow, digest, replaying: replayingOf(records, workflow, digest)[0]?.digest ?? null };
  });
}

/** Where a learned workflow stands, the one word both the promotions read (`serving[].state`) and the learning view
 *  (`workflows[].status`, a draft neither pending nor retired) say: `checking`, its newest record is a check at work, or
 *  it has no record yet (the first claim that lays it and takes its input starts its check; an older revision that
 *  serves keeps serving meanwhile, else the agent takes the runs); `serving`, a revision serves (championOf) and the
 *  money rule lets it run first; `stopped`, the money rule stopped its champion running first (`costStop`, at the
 *  champion's digest: no record says so, the agent takes its runs), or none serves and its newest record is a hold that
 *  stops it (a recompile's check, a second audit hold, nothing to check it on); `held`, else. */
export type ServingState = "serving" | "checking" | "held" | "stopped";
/** Whether the money rule stops `workflow` at `digest` from running first: runner/workflow-first.ts costStopOf over the
 *  agent's runs, the decision a run's claim reads (workflowFirstOf). */
export type CostStop = (workflow: string, digest: string) => boolean;
export function servingStateOf(records: readonly PromotionRecord[], workflow: string, costStop: CostStop): ServingState {
  const newest = records.findLast((one) => one.workflow === workflow);
  if (newest === undefined || newest.decided === "replaying") return "checking";
  const champion = championOf(records, workflow);
  if (champion) return costStop(workflow, champion.digest) ? "stopped" : "serving";
  return newest.decided === "hold" && (newest.check?.stopped || newest.audit?.stopped) ? "stopped" : "held";
}

/** The promotions list as it leaves (GET /agents/{id}/learning/promotions): the records and what serves (servingOf), every
 *  text in them cut by `shown` (learning.ts secretsShown, as the other learning reads cut theirs), at any depth and under
 *  any field, so a field added later is cut too: a workflow's name whole (`shown.name`), any other text of its part
 *  (`shown.text`: a reason, a digest, a run id). Numbers and the rest as they are. A replaying record's `launch` (a run
 *  launch: its notes, model and plane) never leaves: aggregates only. */
export function promotionsShown(records: readonly PromotionRecord[], shown: { readonly text: (text: string) => string; readonly name: (name: string) => string }): { promotions: PromotionRecord[]; serving: ReturnType<typeof servingOf> } {
  return { promotions: records.map(({ launch: _, ...one }) => shownDeep(one, shown) as PromotionRecord), serving: servingOf(records).map((one) => shownDeep(one, shown) as ReturnType<typeof servingOf>[number]) };
}

/** `value` cut as the promotions read cuts its records (promotionsShown), at any depth and under any field: a workflow's
 *  name whole (`shown.name`), any other text of its part (`shown.text`). Numbers and the rest as they are. */
export function shownDeep(value: unknown, shown: { readonly text: (text: string) => string; readonly name: (name: string) => string }, key?: string): unknown {
  return typeof value === "string" ? (key === "workflow" ? shown.name(value) : shown.text(value))
    : Array.isArray(value) ? value.map((one) => shownDeep(one, shown))
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([field, one]) => [field, shownDeep(one, shown, field)]))
    : value;
}

/** What a guarded promotion write did: `won`, whether this write kept its record (else `still` did not hold when it
 *  wrote: another claim's decision came first); `record`, the newest record of its workflow at its digest after (the one
 *  written when won, else the one there, undefined when none). A claim acts on a decision (starts replay runs, cancels)
 *  only when it won the write: the loser reads the winner's record, never its turn to act. */
export type Recorded = { readonly record: PromotionRecord | undefined; readonly won: boolean };

/** Keeps `record` as the newest of its workflow at its digest, when `still` holds of the one there now (none: undefined)
 *  and of every record kept (`items`: a check across revisions, one at a time, in the same guarded write): so of two
 *  claims deciding at once only the first decision is kept, and only its claim acts on it (Recorded.won). */
export async function recordPromotion(settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, agentId: string, record: PromotionRecord, still: (now: PromotionRecord | undefined, items: readonly PromotionRecord[]) => boolean): Promise<Recorded> {
  let out: Recorded = { record, won: true };
  await updateKept<PromotionRecord>(settings, promotionsKey(agentId), (saved) => {
    const items = writtenOf(saved);
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

/** The newest records, at most PROMOTIONS_KEPT, in order, with each workflow's champion (championOf) the same after as
 *  before, whatever was dropped: championOf reads the digest promoted last and its newest record, so the trim keeps both
 *  (a held last revision is never trimmed into handing the champion back), and a replaying revision's newest record (what
 *  its settle, its runs' claims and the one-check-at-a-time rule read: dropped, a newer revision would start a second
 *  check while its runs run, and its verdict would never land). The rest is the newest records. */
export function trimPromotions(items: readonly PromotionRecord[]): PromotionRecord[] {
  if (items.length <= PROMOTIONS_KEPT) return [...items];
  const keep = new Set<number>();
  for (const workflow of new Set(items.map((one) => one.workflow))) {
    for (const one of replayingOf(items, workflow, null)) keep.add(items.lastIndexOf(one));
    const last = lastPromotedOf(items, workflow);
    if (last === undefined) continue;
    keep.add(items.findLastIndex((one) => one.workflow === workflow && one.digest === last && one.decided === "promote"));
    keep.add(items.findLastIndex((one) => one.workflow === workflow && one.digest === last));
  }
  for (let i = items.length - 1, room = PROMOTIONS_KEPT - keep.size; i >= 0 && room > 0; i--) {
    if (keep.has(i)) continue;
    keep.add(i);
    room -= 1;
  }
  return items.filter((_, i) => keep.has(i));
}

/** How many of a replay's own runs ended each way (a run not ended past its deadline is failed): what each run did. A
 *  check record keeps them as it was decided on. */
export type ReplayOutcomes = Readonly<Record<ReplayOutcome, number>>;

/** The text inside an answer that is one unlabelled fence and nothing else, or undefined. */
const WHOLE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\1[`~]*[ \t]*$/;

/** An answer's value: its text as JSON when it is JSON (bare, or the whole of one unlabelled fence), else its last fenced
 *  json block, else its trimmed text. */
function valueOf(answer: string): unknown {
  const text = answer.trim();
  const inner = WHOLE_FENCE.exec(text)?.[2];
  try {
    return JSON.parse(inner ?? text);
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

/** A grade as the API answers it (PUT /runs/{id}/grade; GET /runs/{id}/learning's `graded`, without `expected`). */
export const gradeView = (grade: Grade) => ({
  run_id: grade.run, correct: grade.correct, ...(grade.expected ? { expected: grade.expected } : {}), source: grade.source, graded_at: grade.at,
  path: grade.path, workflow: grade.workflow ?? null, workflow_digest: grade.digest ?? null, feedback: grade.feedback ?? null,
});
