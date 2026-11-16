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
import type { FeedbackRound, OpenedRound } from "../runner/feedback-round.js";
import type { Settings } from "../store/store.js";
import { answerJson } from "../answer-json.js";
import { workflowNodes } from "./workflow-nodes.js";
import type { Skipped } from "./replay-calls.js";
import type { ReplayOutcome } from "../runner/workflow-first.js";

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

/** The most characters a grade's words (`label`) may hold, and the most of them and of a wrong answer a revise ask shows. */
export const LABEL_MAX = 4_000;

export const GRADE_SOURCES =["feedback", "eval"] as const;
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
  /** The promotion of `digest` that served the run (its record's `since`, PromotionRecord.since), read from the run's
   *  record when it was graded: a serving check counts the grade only for that promotion. Absent: one with no since (the
   *  digest's first), or none served it. Not in the API's view. */
  readonly promotion?: number;
  /** The feedback round the grade opened its run again on, null for none (runner/feedback-round.ts keepGrade). Set only
   *  once the round opened, so a kept grade never names a round that didn't. */
  readonly feedback?: FeedbackRound | null;
  /** The steer command that round opened the run again on (store.runs.reopen's id), set with `feedback`: the run's journal
   *  and that steer's row say how that round stands (runner/feedback-round.ts feedbackStatus), never a clock. Not in the
   *  API's view. */
  readonly feedbackCommand?: number;
}

/** What a replay says (learn/refit.ts scoreRows), the shape the promotion record keeps (SPEC: replay {n, agree, agent_acc, wf_acc, delta}):
 *  `n` inputs; `agree`, how many the workflow answered alone with the graded run's recorded answer; `agent_acc`, the
 *  agent's accuracy on them (agentRight); `wf_acc`, the workflow's, a hand-back counting as the agent's answer; `delta` = wf_acc -
 *  agent_acc; `handed_back`, how many it handed back (it answered n - handed_back alone: answersAlone). Accuracies to
 *  1e-4. */
export interface ReplayScore {
  readonly n: number;
  readonly agree: number;
  readonly agent_acc: number;
  readonly wf_acc: number;
  readonly delta: number;
  readonly handed_back: number;
}

/** The ReplayScore fields of `x` alone (a scoreRows or refitGuards result, or a record's `replay`): the one pick of them. */
export const scoreOf = (x: ReplayScore): ReplayScore => ({ n: x.n, agree: x.agree, agent_acc: x.agent_acc, wf_acc: x.wf_acc, delta: x.delta, handed_back: x.handed_back });

/** Whether a replay or refit answered alone on at least one of its inputs: one that hands back every input would never
 *  serve. The one spelling of it (clears, settle's hold, the compile's held line); the count is n - handed_back. */
export const answersAlone = (score: Pick<ReplayScore, "n" | "handed_back">): boolean => score.handed_back < score.n;

/** A learned workflow's promotion record at one digest. `decided`: `promote` (it serves first), `hold` (it does not: the
 *  champion, championOf, takes its runs, else the agent, until a new revision), `replaying` (its replay runs, `runs`,
 *  are at work; the champion serves meanwhile, else the agent), `queued` (it came while another revision replayed: one
 *  replays at a time, and a running replay finishes; it replays next once that one is decided, unless a newer revision
 *  comes first), or `skipped` (a newer revision, `skipped_by`, came while it was queued: only the newest queued one
 *  replays next, so it never replayed and never serves). `source`: `replay` (decided on its replay), `dry_run` (fewer than REPLAY_MIN graded inputs: promoted on
 *  its passing dry run), `refit` (a threshold refit wrote this revision, decided on the rows it was fit on), `graded` (a
 *  serving revision's graded runs fell below the bar: held). `replay`: the numbers it was decided on, with the graded runs
 *  replayed (`of`), what its replay runs cost (`cost_usd`, null when one's is unknown), its runs' outcomes (`outcomes`,
 *  ReplayOutcomes: the one count of them, its `skipped_write` the inputs that needed a write the graded run's recording
 *  does not have, learn/replay-calls.ts, never run, never scored) and the tools that stopped those (`skipped_tools`,
 *  SkippedTool). `refit`: the guards a refit
 *  changed. `checked`: the newest grade (its seq) the last refit check read (refits run once per REFIT_EVERY more graded runs
 *  it served, counted by seq: a count of the grades kept stalls once the GRADES_KEPT trim holds it). `since`: on a replay's
 *  promote, the agent's newest grade (its seq) when this promotion began: which promotion of the digest it is (a run it
 *  serves keeps it, Grade.promotion, and its checks count only those runs' grades). `held_on`: the
 *  served runs graded wrong a revision was held on, owed by its next replay (runner/promotion.ts heldOn). */
export interface PromotionRecord {
  readonly workflow: string;
  readonly digest: string;
  readonly at: string;
  readonly decided: "promote" | "hold" | "replaying" | "queued" | "skipped";
  readonly source: "replay" | "dry_run" | "refit" | "graded";
  readonly reason: string;
  readonly replay?: ReplayScore & { readonly of: readonly string[]; readonly cost_usd?: number | null; readonly skipped_tools?: readonly SkippedTool[]; readonly outcomes?: ReplayOutcomes };
  readonly runs?: readonly string[];
  /** A replaying record's graded runs, one per `runs` entry in order: the input each reserved replay run replays, so a
   *  launch interrupted after the reservation is finished by a later claim (runner/promotion.ts relaunch). */
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
  readonly refit?:{ readonly from: string; readonly guards: readonly RefitGuard[] };
  readonly checked?: number;
  /** A promote record's start (a replay's promote): the agent's newest grade's seq when it was written, which names this
   *  promotion of the digest: a run it serves keeps it (metrics.workflow_promotion, then Grade.promotion), and its checks
   *  count only the grades of those runs, never a run served under an earlier promotion and graded after this one, nor
   *  the ones it was held on. Two promotions of a digest never share it: one is promoted again only after a graded hold,
   *  which counts runs served (and graded, each at a newer seq) under the one before. Its checks' writes are kept only
   *  while it is still the digest's promotion (the same since), so a check that read an older promotion writes nothing.
   *  Absent: the digest's first record (a dry run's or a refit's promote), whose runs keep none. */
  readonly since?: number;
  /** The runs a revision served that were graded wrong when its graded check held it (newest first, at most REPLAY_INPUTS),
   *  kept on that hold, on the replay of it its owner starts (those of them still graded and fitting it, each one of its
   *  inputs), and on a replay's hold: a replay of the revision promotes it only once it answered (or handed back) on every
   *  one (runner/promotion.ts heldOn). */
  readonly held_on?: readonly string[];
  /** A skipped revision's newer one: the digest that came while it was queued, and replays in its place. */
  readonly skipped_by?: string;
  /** The learning commit whose workflows/<workflow>/workflow.json is this digest's text: the seed of the claim that
   *  recorded it, or a refit's own commit. What the digest serves from as the champion (championOf) once a newer revision
   *  is on the folder's main. */
  readonly commit?: string;
}

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
export function skippedToolsOf(rows: readonly ReplayRow[]): SkippedTool[] {
  const by = new Map<string, { inputs: number; unmarked: boolean }>();
  for (const row of rows) {
    if (row.outcome !== "skipped_write" || !row.skipped) continue;
    const was = by.get(row.skipped.tool) ?? { inputs: 0, unmarked: true };
    by.set(row.skipped.tool, { inputs: was.inputs + 1, unmarked: was.unmarked && row.skipped.unmarked === true });
  }
  return [...by].map(([tool, one]) => ({ tool, inputs: one.inputs, no_read_only_hint: one.unmarked }))
    .sort((a, b) => b.inputs - a.inputs || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/** One switch a refit changed: a guard's step, its threshold before and after (`threshold` null: the guard switched off,
 *  gone from the revision), and its new fit when one was fit; or an escalate node a replay recorded (dsl softEscalates),
 *  switched off (`escalate`: gone from the revision; `was` and `threshold` null, it had none). */
export interface RefitGuard {
  readonly node: string;
  readonly was: number | null;
  readonly threshold: number | null;
  readonly fit?: { readonly w: readonly number[]; readonly b: number; readonly n: number; readonly fitted_at: string };
  readonly escalate?: true;
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
 *  that round's steer, in place: its `seq` stays, so a serving digest's check never counts it twice. A newer grade of the
 *  run is left as it is, one given in the same millisecond too (its `seq` is another). The grade, marked. */
export const markGradeRound = async (settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, agentId: string, grade: Grade, opened: OpenedRound): Promise<Grade> => {
  const mark = { feedback: opened.round, feedbackCommand: opened.command };
  await updateKept<Grade>(settings, gradesKey(agentId), (items) => items.map((one) => (one.run === grade.run && one.at === grade.at && one.seq === grade.seq ? { ...one, ...mark } : one)));
  return { ...grade, ...mark };
};

/** The agent's promotion records, oldest first. A beta.39 store may hold `decided: "superseded"` (a replay a newer draft
 *  cancelled; beta.40 writes `skipped` for an older draft instead): read as `skipped`, `skipped_by` the draft that
 *  superseded it, with a reason that says when. Only the read maps: the stored record is never rewritten. */
export const promotionsOf = async (settings: Pick<Settings, "get">, agentId: string): Promise<PromotionRecord[]> =>
  itemsOf<PromotionRecord>(await settings.get(promotionsKey(agentId))).map((one) => {
    const { superseded_by: by, ...rest } = one as PromotionRecord & { superseded_by?: string };
    return (one.decided as string) === "superseded"
      ? { ...rest, decided: "skipped", reason: "a newer draft arrived while it replayed (before beta.40)", ...(by ? { skipped_by: by } : {}) }
      : one;
  });

/** The newest record of `workflow` at `digest`, or undefined. */
export const promotionOf = (records: readonly PromotionRecord[], workflow: string, digest: string): PromotionRecord | undefined =>
  records.findLast((one) => one.workflow === workflow && one.digest === digest);

/** The champion of `workflow`: the newest record of the digest promoted last (a digest's place is its latest win's,
 *  winsOf), while that digest's newest record still says promote. A newer revision replaying or held never stops it; a
 *  wrong served grade asks for a revision and never stops it; it stops when a newer revision's replay promotes that one
 *  (then the champion), or its own graded runs hold it (source graded: no champion until a revision is promoted). A held
 *  revision its owner replays (runner/promotion.ts askReplay) and the replay promotes wins again: the champion from then.
 *  The money rule stops it on its own (runner/workflow-first.ts). Undefined: none. */
export function championOf(records: readonly PromotionRecord[], workflow: string): PromotionRecord | undefined {
  const last = lastPromotedOf(records, workflow);
  const now = last === undefined ? undefined : promotionOf(records, workflow, last);
  return now?.decided === "promote" ? now : undefined;
}

/** Each promote record's win, by index: the index of the promote record that began its digest's run of promote records
 *  (its first, or the first after a record of that digest that was not promote: a replay that promoted a held revision).
 *  A graded check's mark (a promote after a promote, runner/promotion.ts stillServing) is never a win of its own. */
function winsOf(records: readonly PromotionRecord[]): Map<number, number> {
  const wins = new Map<number, number>();
  const streak = new Map<string, number>();
  records.forEach((one, i) => {
    const at = JSON.stringify([one.workflow, one.digest]);
    if (one.decided !== "promote") return void streak.delete(at);
    if (!streak.has(at)) streak.set(at, i);
    wins.set(i, streak.get(at)!);
  });
  return wins;
}

/** The digest of `workflow` promoted last: the one whose latest win (winsOf) is the newest of every digest's. */
function lastPromotedOf(records: readonly PromotionRecord[], workflow: string): string | undefined {
  let last: string | undefined;
  for (const [i, win] of winsOf(records)) if (i === win && records[i]!.workflow === workflow) last = records[i]!.digest;
  return last;
}

/** The revisions of `workflow` other than `digest` whose newest record still says `decided` (replaying, else queued),
 *  newest first: at most one replaying (one replay at a time, the reservation's guarded write), and at most one queued
 *  once each newer one skips the one queued before it (runner/promotion.ts). */
export function replayingOf(records: readonly PromotionRecord[], workflow: string, digest: string | null, decided: "replaying" | "queued" = "replaying"): PromotionRecord[] {
  const out: PromotionRecord[] = [];
  for (const one of [...records].reverse()) {
    if (one.workflow !== workflow || one.digest === digest || out.some((seen) => seen.digest === one.digest)) continue;
    if (promotionOf(records, workflow, one.digest) === one && one.decided === decided) out.push(one);
  }
  return out;
}

/** What each learned workflow with a record serves, by name: `digest`, its champion's (championOf; null: none serves,
 *  the agent takes its runs), and `replaying`, the revision other than it whose replay is at work (null: none; a queued
 *  one is not at work yet). What the promotions list says beside the records
 *  (GET /agents/{id}/learning/promotions). */
export function servingOf(records: readonly PromotionRecord[]): { workflow: string; digest: string | null; replaying: string | null }[] {
  const names = [...new Set(records.map((one) => one.workflow))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((workflow) => {
    const digest = championOf(records, workflow)?.digest ?? null;
    return { workflow, digest, replaying: replayingOf(records, workflow, digest)[0]?.digest ?? null };
  });
}

/** The promotions list as it leaves (GET /agents/{id}/learning/promotions): the records and what serves (servingOf), every
 *  text in them cut by `shown` (learning.ts secretsShown, as the other learning reads cut theirs), at any depth and under
 *  any field, so a field added later is cut too: a workflow's name whole (`shown.name`), any other text of its part
 *  (`shown.text`: a reason, a refit guard's label, a digest, a run id). Numbers and the rest as they are. A replaying
 *  record's `launch` (a run launch: its notes, model and plane) never leaves: aggregates only. */
export function promotionsShown(records: readonly PromotionRecord[], shown: { readonly text: (text: string) => string; readonly name: (name: string) => string }): { promotions: PromotionRecord[]; serving: ReturnType<typeof servingOf> } {
  const cut = (value: unknown, key?: string): unknown =>
    typeof value === "string" ? (key === "workflow" ? shown.name(value) : shown.text(value))
    : Array.isArray(value) ? value.map((one) => cut(one))
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([field, one]) => [field, cut(one, field)]))
    : value;
  return { promotions: records.map(({ launch: _, ...one }) => cut(one) as PromotionRecord), serving: servingOf(records).map((one) => cut(one) as ReturnType<typeof servingOf>[number]) };
}

/** What a guarded promotion write did:`won`, whether this write kept its record (else `still` did not hold when it
 *  wrote: another claim's decision came first); `record`, the newest record of its workflow at its digest after (the one
 *  written when won, else the one there, undefined when none). A claim acts on a decision (starts replay runs, refits,
 *  cancels) only when it won the write: the loser reads the winner's record, never its turn to act. */
export type Recorded = { readonly record: PromotionRecord | undefined; readonly won: boolean };

/** Keeps `record` as the newest of its workflow at its digest, when `still` holds of the one there now (none: undefined)
 *  and of every record kept (`items`: a check across revisions, one challenger at a time, in the same guarded write): so
 *  of two claims deciding at once only the first decision is kept, and only its claim acts on it (Recorded.won). `also`:
 *  records kept after it in the same write, all or none (a queue change and the skips it makes, runner/promotion.ts). */
export async function recordPromotion(settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, agentId: string, record: PromotionRecord, still: (now: PromotionRecord | undefined, items: readonly PromotionRecord[]) => boolean, also: readonly PromotionRecord[] = []): Promise<Recorded> {
  let out: Recorded = { record, won: true };
  await updateKept<PromotionRecord>(settings, promotionsKey(agentId), (items) => {
    const now = promotionOf(items, record.workflow, record.digest);
    if (!still(now, items)) {
      out = { record: now, won: false };
      return items;
    }
    out = { record, won: true };
    return trimPromotions([...items, record, ...also]);
  });
  return out;
}

/** The newest records, at most PROMOTIONS_KEPT, in order, with each workflow's champion (championOf) the same after as
 *  before, whatever was dropped. championOf reads two things, and the trim keeps both: the place of every digest it can
 *  still see promoted (a promote record kept keeps its win, winsOf, beside it, so an older revision's late graded check
 *  never reads as a newer promotion), and the digest promoted last, its latest win and its newest record (so a held last
 *  revision is never trimmed into handing the champion back). The kept records are a run of the newest plus those wins,
 *  and a win's own run reaches no further back than it: a record that ended an older run of the same digest is newer
 *  than every record of that run, so a run is never joined to an older one by the trim. The queue's state is kept too,
 *  whatever its age: a replaying revision's newest record (what its settle, its runs' claims and the one-replay-at-a-time
 *  check read: dropped, a newer revision would start a second replay while its runs run, and its verdict would never
 *  land) and a queued one's (what replays next). Neither is a promote record, so championOf reads the same. */
export function trimPromotions(items: readonly PromotionRecord[]): PromotionRecord[] {
  if (items.length <= PROMOTIONS_KEPT) return [...items];
  const wins = winsOf(items);
  const placeOf = (i: number): number | undefined => wins.get(i);
  const keep = new Set<number>();
  for (const workflow of new Set(items.map((one) => one.workflow))) {
    for (const one of [...replayingOf(items, workflow, null), ...replayingOf(items, workflow, null, "queued")]) keep.add(items.lastIndexOf(one));
    const last = lastPromotedOf(items, workflow);
    if (last === undefined) continue;
    const newest = items.findLastIndex((one) => one.workflow === workflow && one.digest === last);
    // Its latest win: the newest win of that digest.
    keep.add(Math.max(...[...wins].filter(([i, win]) => i === win && items[i]!.workflow === workflow && items[i]!.digest === last).map(([i]) => i)));
    keep.add(newest);
  }
  for (let i = items.length - 1, room = PROMOTIONS_KEPT - keep.size; i >= 0 && room > 0; i--) {
    if (keep.has(i)) continue;
    const place = placeOf(i);
    const adds = place === undefined || keep.has(place) || place === i ? 1 : 2;
    if (adds > room) break;
    keep.add(i);
    if (place !== undefined) keep.add(place);
    room -= adds;
  }
  return items.filter((_, i) => keep.has(i));
}

/** One replayed input: the graded run it replays (`of`), its recorded answer, its grade and the path it took (whose
 *  answer it is: agentRight), and what the workflow
 *  did on it: answered alone (`answer`), handed back (it escalated: an escalate node or a guard), or failed (a step failed,
 *  on a credential or tool the replay lacked among them, or its output off its schema; no workflow, a stale digest, a run
 *  that did not end completed); with its guard rows, read record-only (recordOnly) so each step's p is known. A failed
 *  row is no evidence either way (learn/refit.ts refitRowsOf leaves it out): the replay ran without what the run it replays had. A
 *  skipped one (`skipped_write`) is none either: its workflow stopped at a write the graded run's recording does not have,
 *  which a replay never runs (learn/replay-calls.ts), the one named in `skipped`. */
export interface ReplayRow {
  readonly of: string;
  readonly recorded: { readonly answer: string | null; readonly correct: boolean; readonly path: RunPath; readonly expected?: Readonly<Record<string, unknown>> };
  readonly outcome: ReplayOutcome;
  readonly skipped?: Skipped;
  readonly answer: string | null;
  readonly guards: readonly GuardRow[];
}

/** How many of a replay's own runs ended each way (a run not ended past its deadline is failed): what each run did,
 *  never the serving thresholds' reading of it (a run that answered below its guard's threshold is answered here, handed
 *  back in its score). A replay record keeps them as it was decided on. */
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

/** Whether the workflow's `answer` to a graded input is right by its grade: with the grade's expected fields, when its JSON
 *  holds each of them (or, one field expected, when the answer is that field's value: a workflow whose output is one
 *  field answers with its text, or its JSON text when it is no text, learned-workflow.ts learnedOutput). Else, graded
 *  right, when it says what the graded run said. Graded wrong: on a run a learned workflow answered alone (`workflow`),
 *  when it says anything else (the bar on a wrong grade is the grade: saying what was graded wrong again is never a tie),
 *  and wrong when what it said could not be read (nothing says it differs); on a run the agent answered, wrong whatever it
 *  says (another answer proves nothing: a neutral tie with the agent's, agentRight). */
export function answerCorrect(answer: string | null, recorded: ReplayRow["recorded"]): boolean {
  if (answer === null) return false;
  if (recorded.expected) {
    const value = valueOf(answer);
    const fields = Object.values(recorded.expected);
    if (fields.length === 1 && (typeof fields[0] === "string" ? answer.trim() === fields[0].trim() : same(value, fields[0]))) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.entries(recorded.expected).every(([key, want]) => same((value as Record<string, unknown>)[key], want));
  }
  if (recorded.correct) return sameAnswer(answer, recorded.answer);
  return recorded.path === "workflow" && recorded.answer !== null && !sameAnswer(answer, recorded.answer);
}

/** Whether the agent's answer to a replayed input is right, the agent's side of a replay's score: the graded run's grade
 *  when the answer graded is the agent's (path `agent`, or `handed_back`: the agent finished it). On a run a learned
 *  workflow answered alone (`workflow`) the store holds no answer of the agent's on that input, so a right grade is the
 *  agent's too and a wrong one counts the agent right: the grade's expected answer is the agent's when it gave one, and
 *  with none the agent is the default. So a revision held on runs it served wrong never ties its own wrong answers; it
 *  serves again only by answering them right (answerCorrect) or handing them back. */
export const agentRight = (recorded: ReplayRow["recorded"]): boolean => recorded.correct || recorded.path === "workflow";

/** The thresholds a workflow's guards serve at, by step label (the guard rows' `node`): every step of the workflow
 *  with a `guard` and a `label` (walkGuards). A label names one step: a learned draft that repeats one never runs
 *  (skills.ts draftProblems, repeatedLabels), so no two steps' rows share a threshold here or in a refit. */
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
 *  guard rows (scopeDepsToChild), so a nested guard's serving threshold and its refit read the rows it made. Only the
 *  workflow's node positions (workflow-nodes.ts): a call's args or a schema shaped like `{label, guard}` is data, never
 *  a guard, so a replay or a refit never changes it. */
export function walkGuards(doc: unknown, visit: (label: string, guard: Record<string, unknown>, node: Record<string, unknown>) => void): void {
  for (const { node, prefix } of workflowNodes(doc)) {
    const guard = node.guard;
    if (typeof node.label === "string" && guard && typeof guard === "object" && !Array.isArray(guard)) visit(`${prefix}${node.label}`, guard as Record<string, unknown>, node);
  }
}

/** The threshold a soft escalate's row (GuardRow signal `escalate`) is read at: its p is 0 when it fired, else 1, so it
 *  hands back at its serving setting exactly when it fired. */
export const SOFT_ESCALATE_THRESHOLD = 0.5;

/** The threshold a replay's guards read at: the least the DSL takes (a threshold is in (0, 1), exclusive), so a guard
 *  hands back only when p is null (a signal it reads is missing) or 0. */
export const RECORD_ONLY_THRESHOLD = 1e-9;

/** A workflow's text with every guard's threshold at RECORD_ONLY_THRESHOLD: each guard still reads its signals and
 *  records its row. What a replay runs, so every step's p is known for the refit and the serving thresholds are applied
 *  after (learn/refit.ts scoreRows). The text unchanged when it has no guard. */
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

/** Whether a score clears the bar: the workflow's accuracy at most PROMOTE_BAR under the agent path's, and it answered
 *  alone on at least one input (one that hands back every input scores the agent's own accuracy, and would never serve). */
export const clears = (score: Pick<ReplayScore, "delta" | "n" | "handed_back">): boolean => withinBar(score) && answersAlone(score);

/** Whether a score's workflow is at most PROMOTE_BAR under the agent: clears' bar, and what a replay of a held revision
 *  meets on the runs it was held on alone (runner/promotion.ts settle), where a hand-back on each is fine. */
export const withinBar = (score: Pick<ReplayScore, "delta">): boolean => score.delta >= -PROMOTE_BAR - 1e-9;

/** A grade as the API answers it (PUT /runs/{id}/grade; GET /runs/{id}/learning's `graded`, without `expected`). */
export const gradeView = (grade: Grade) => ({
  run_id: grade.run, correct: grade.correct, ...(grade.expected ? { expected: grade.expected } : {}), source: grade.source, graded_at: grade.at,
  path: grade.path, workflow: grade.workflow ?? null, workflow_digest: grade.digest ?? null, feedback: grade.feedback ?? null,
});
