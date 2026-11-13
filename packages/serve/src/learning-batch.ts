// Learn from a CSV: a learning batch (POST /agents/{id}/learning/batches). A person gives rows, which columns are the input
// and which the answer, and a cap; the server runs the agent on each row in order with learning on, and after each run tells
// it the reference answer next to its own, the hindsight review the learning bench sends (learn-bench's follow-up: a message
// to the finished run, which looks back again). The batch's progress is the store's, never the browser's: a header per batch
// and one key per row in the server's settings (no table). The batch and each row are one machine (BATCH_MOVES, ROW_MOVES):
// every move is one write, in an order where a stop between any two writes leaves a state the next start takes up, and every
// side effect (a run's start, its review) is keyed so a move taken again finds it done. One row at a time, since what a row
// teaches is what the next one is given.
// Nothing here knows a job: the input is the chosen columns as {column: value}, the match is structural equality (a display,
// not a judge: the learning grade is the judge), and the words of the review are generic.
import { randomBytes } from "node:crypto";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { EFFORTS } from "./model.js";
import { isObject, unknownFields } from "./validate.js";
import type { RunPath } from "./learning-cost.js";
import type { Shown } from "./learning.js";
import type { Settings } from "./store/store.js";

/** The most rows a batch holds, and the longest a cell, in characters (the whole body is under the server's body limit). */
export const BATCH_ROWS_MAX = 500;
export const BATCH_CELL_MAX = 8_000;
const COLUMNS_MAX = 40;

export type BatchStatus = "running" | "completed" | "cancelled" | "stopped";
/** Why a batch stopped before its last row: its cap has no room for another row, a row's cost is not known (never guessed),
 *  the agent no longer learns here (learning turned off for it or for the server: a row is never run unlearned). */
export type BatchStop = "cap" | "cost_unknown" | "learning_off";
export type RowState = "pending" | "running" | "done" | "failed";
/** A row's stage in its machine, read from its record (stageOf): `running` is started, answered or reviewed. */
export type Stage = "pending" | "started" | "answered" | "reviewed" | "done" | "failed";
/** The row machine. pending -> started: its run started under the row's key (a start the server stopped before this write
 *  is found again by the key); started -> answered: the run's first end, its answer, right or wrong and the review's words
 *  written once; answered -> reviewed: the review sent (a resume finds it in the run's commands and sends none); reviewed ->
 *  done: the review's turn completed and its learning settled. Every other ending is failed, and a live row (started,
 *  answered, reviewed) moves to failed only once its run has stopped (cancelled, waited for with its grade, then booked). */
export const ROW_MOVES: Readonly<Record<Stage, readonly Stage[]>> = { pending: ["started", "failed"], started: ["answered", "failed"], answered: ["reviewed", "failed"], reviewed: ["done", "failed"], done: [], failed: [] };
const LIVE: ReadonlySet<Stage> = new Set<Stage>(["started", "answered", "reviewed"]);
export const stageOf = (row: Row): Stage => (row.state !== "running" ? row.state : row.reviewed ? "reviewed" : row.right !== undefined ? "answered" : "started");
/** How a batch ends, written before its live row is stopped (the batch's `ending` stage): a stop between the two leaves a
 *  batch the next start ends this way, never one it runs on. */
export type Ending = { status: Exclude<BatchStatus, "running">; stopped: BatchStop | null; error?: string };
/** The batch machine, in its header: made (the agent's index, then the rows, then the header, so a header is never saved
 *  where a read can't find it) -> running -> ending (one write: `ending`) -> completed, cancelled or stopped (one write, once
 *  no row is live). A start takes up every header still running: a running one at its first unfinished row, an ending one
 *  where its ending stands. */
export const BATCH_MOVES: Readonly<Record<"running" | "ending" | Exclude<BatchStatus, "running">, readonly string[]>> = { running: ["ending"], ending: ["completed", "cancelled", "stopped"], completed: [], cancelled: [], stopped: [] };

type Lessons = { notes: string[]; skills: string[]; workflows: string[] };
/** One row as the store keeps it. `input` and `reference` are the person's; `answer` the run's, cut. */
export type Row = {
  n: number;
  state: RowState;
  input: Record<string, string>;
  reference: string;
  run_id?: string;
  /** The run's answer as compared (its answer_field's value when the batch names one), cut at ANSWER_SHOWN for display, and
   *  whether it is the reference (the whole answer compared): written once, when the run first answers, never again (the
   *  reply to the review is no answer). */
  answer?: string | null;
  right?: boolean;
  /** The run's end the review follows (its ended_at when it answered): the review's own end is a later one. */
  review_after?: string | null;
  /** The review's words, decided with the answer (from the whole answer: reviewText) and sent as they are. Not shown. */
  review?: string;
  /** The review was sent to the run (the run's commands hold it: a resume that finds it there sends none). */
  reviewed?: boolean;
  /** The path the run's job took, read when it answered, before its review: whoever wrote the run's answer (the review's
   *  turn adds a message, and a run a learned workflow answered alone would read handed_back after it). */
  path?: RunPath;
  cost_usd?: number | null;
  learning_usd?: number | null;
  total_usd?: number | null;
  learned?: Lessons;
  /** The commit of the agent's learning folder the run's learning last merged, when it did. */
  merged?: string | null;
  /** Each round of the run's learning that merged workflows (the job's, the review's), in order: its commit and its
   *  workflows. The header's `revisions` (not shown in the row). */
  revisions?: Revision[];
  error?: string;
};
/** A merge that touched learned workflows: its commit of the agent's learning folder and the workflows it added or changed. */
export type Revision = { commit: string | null; workflows: string[] };

export type Header = {
  id: string;
  agent_id: string;
  created_at: string;
  ended_at: string | null;
  status: BatchStatus;
  stopped: BatchStop | null;
  inputs: string[];
  answer: string;
  answer_field: string | null;
  effort: string | null;
  max_cost_usd: number;
  total: number;
  /** Rows finished (done or failed), and of them: right, wrong (answered, not matching), failed. Every figure from here to
   *  `revisions` is the rows' (tally): folded from the rows as saved, never added to, so a stop between two writes loses none. */
  finished: number;
  right: number;
  wrong: number;
  failed: number;
  /** The rows' total $ (job and learning) of the rows finished, and how many of them cost nothing known. */
  spent_usd: number;
  unknown_cost_rows: number;
  /** Rows finished by the path their run took. */
  paths: Record<RunPath, number>;
  /** What the batch's learning kept, each name once, and the merges that touched workflows: [{row, commit, workflows}]. */
  lessons: Lessons;
  revisions: { row: number; commit: string | null; workflows: string[] }[];
  /** The words of a loop that failed on the store itself (never a row's failure: that is the row's). */
  error?: string;
  /** Set while the batch ends (BATCH_MOVES `ending`): how it ends, once its live row has stopped. Not shown. */
  ending?: Ending;
};

/** What the loop reads of a run, from the server's view of it. */
export type RunSnap = { status: string; ended_at: string | null; answer: string | null; cost_usd: number | null; learning_state: string | null; error: string | null };
/** What a finished run's learning and cost say (store-reads/learning.ts costRunOf, runLearningEnd): figuresOf. */
export type Figures = { path: RunPath; cost_usd: number | null; learning_usd: number | null; total_usd: number | null; learned: Lessons; merged: string | null; revisions: Revision[] };
/** A round's learning end as figuresOf reads it (store-reads/learning.ts RunLearningEnd): null for a round that kept none. */
type RoundEnd = { merged?: string | null; learned?: readonly { name: string }[]; skills?: readonly { name: string }[]; workflows?: readonly { name: string }[] } | null;
/** A run's figures from its cost (costRunOf) and the end of each round its learning kept, in order (the job's, then each
 *  follow-up's, a review's): what every round learned, each name once; the last merge's commit; and each round that merged
 *  workflows as a revision of its own, with its own commit (a round dropped is none, and moves no other round's commit). */
export function figuresOf(cost: Pick<Figures, "path" | "cost_usd" | "learning_usd" | "total_usd">, ends: readonly RoundEnd[]): Figures {
  const names = (pick: (e: NonNullable<RoundEnd>) => readonly { name: string }[] | undefined) => [...new Set(ends.flatMap((e) => (e ? (pick(e) ?? []).map((x) => x.name) : [])))];
  const revisions = ends.flatMap((e) => (e?.workflows?.length ? [{ commit: e.merged ?? null, workflows: [...new Set(e.workflows.map((w) => w.name))] }] : []));
  const merged = [...ends].reverse().find((e) => e?.merged)?.merged ?? null;
  return { path: cost.path, cost_usd: cost.cost_usd, learning_usd: cost.learning_usd, total_usd: cost.total_usd, merged, revisions, learned: { notes: names((e) => e.learned), skills: names((e) => e.skills), workflows: names((e) => e.workflows) } };
}

/** Everything the loop needs of the server, injected: the run-create path that POST /agents/{id}/runs checks and starts by,
 *  the message path, the run's view, its figures. */
export interface BatchHost {
  settings: Settings;
  /** Whether the agent's current revision learns, and whether the server lets runs learn (else why not). */
  learning(agentId: string): Promise<{ learns: true } | { learns: false; why: string }>;
  /** The run started under `key` (a row's: ROW_KEY), if one was: a start the server stopped before its row kept the id. */
  find(key: string): Promise<string | undefined>;
  /** Starts a run under `key`, the store's run origin, so a retry finds it (find) and never starts a second. */
  start(agentId: string, body: Record<string, unknown>, key: string): Promise<string>;
  view(runId: string): Promise<RunSnap | undefined>;
  /** Whether the run was already sent `content` (its commands hold it): a review is sent once, across a restart too. */
  sent(runId: string, content: string): Promise<boolean>;
  message(runId: string, content: string): Promise<void>;
  /** Asks the run to stop; nothing for a run that has ended. Never swallowed: a live row is let go only once this held. */
  cancel(runId: string): Promise<void>;
  /** A run's figures as booked (costRunOf): what it has spent so far, its learning's every round included (a run still going
   *  counts its live cost), so the live figure and the booked one are one function. */
  figures(runId: string): Promise<Figures | undefined>;
  /** What a read shows of agent `agentId`'s batches: the learning routes' cut as it is now (server.ts learningShown: the
   *  server's secrets and the agent's sign-in pointers, live and forgotten), every read's, so a value saved as a secret
   *  after its row finished is cut too. Throws (403, WITHHELD_LEARNING) when a pointer can't be read here: withheld,
   *  never shown over a shorter cut. */
  shown(agentId: string): Promise<Shown>;
  /** How often a wait looks, the longest a row waits on its run (and its learning) before it is cancelled, and the longest
   *  an ending row waits for its run and grade to stop (past it, its cost is not known). */
  pollMs?: number;
  rowTimeoutMs?: number;
  settleMs?: number;
  now?: () => number;
}

const ANSWER_SHOWN = 2_000;
/** The least cap a run can take a step under (cap.ts: the next step needs at least a cent). */
export const RUN_CAP_MIN_USD = 0.01;
const HEAD = (id: string) => `learning_batch/${id}`;
const ROW = (id: string, n: number) => `learning_batch/${id}/row/${n}`;
const INDEX = (agentId: string) => `learning_batches/${agentId}`;
/** The run origin a row's run starts under: one run a row, whatever stops between its start and its row's write. */
export const ROW_KEY = (id: string, n: number) => `learning_batch:${id}:row:${n}`;
export const BATCH_ID = /^lb_[0-9a-f]{16}$/;

const text = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
/** A decimal number's text in one form (no sign on zero, no leading or trailing zeros), never through a float: two numbers
 *  are the same when every digit is. Null for text that is no decimal number. */
const num = (value: string): string | null => {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return null;
  const whole = m[2]!.replace(/^0+(?=\d)/, ""), part = (m[3] ?? "").replace(/0+$/, "");
  const sign = m[1] === "-" && !(whole === "0" && part === "") ? "-" : "";
  return `${sign}${whole}${part ? `.${part}` : ""}`;
};
/** The answer's field at a dotted path, from the answer text when it is JSON (or holds a fenced json block); the answer as it
 *  is when no field is named. A value that is not a scalar, or a path that is not there, is no answer (null). */
export function answerValue(answer: string | null, field: string | null): string | null {
  if (answer === null) return null;
  if (field === null) return answer;
  for (const candidate of [answer, /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(answer)?.[1]]) {
    try {
      let at: unknown = JSON.parse(candidate ?? "");
      for (const key of field.split(".")) at = at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined;
      if (typeof at === "string" || typeof at === "number" || typeof at === "boolean") return String(at);
    } catch {}
  }
  return null;
}
/** Whether an answer is the reference: equal once trimmed, case-folded and whitespace-collapsed, two numbers by value (by
 *  every digit: num). */
export function matches(answer: string | null, reference: string): boolean {
  if (answer === null) return false;
  const a = num(answer.trim()), r = num(reference.trim());
  return a !== null && r !== null ? a === r : text(answer) === text(reference);
}
/** What a run is given for a row: its one input column's text as it is, or each chosen column on a line, `column: value`, in
 *  the order the batch names them (an agent's input is its `content`, a person's words). */
export const contentOf = (inputs: readonly string[], row: Record<string, string>): string => (inputs.length === 1 ? row[inputs[0]!]! : inputs.map((column) => `${column}: ${row[column]}`).join("\n"));
/** The review a run is sent, from its whole answer: the same words right or wrong. An answer past ANSWER_SHOWN characters is
 *  quoted to there, and the review says it was cut and where the whole one is (never a prefix passed off as the answer). */
export const reviewText = (reference: string, answer: string | null): string =>
  answer !== null && answer.length > ANSWER_SHOWN
    ? `Review: the reference answer is "${reference}"; you answered "${answer.slice(0, ANSWER_SHOWN)}…" (cut here: your answer runs to ${answer.length} characters, and the whole of it is your last answer in this run).`
    : `Review: the reference answer is "${reference}"; you answered "${answer ?? "nothing"}".`;

/** A create's body, checked: its issues, or the parsed batch. */
export function checkBatchBody(body: Record<string, unknown>): InputIssue[] | { inputs: string[]; answer: string; answer_field: string | null; effort: string | null; max_cost_usd: number; rows: { input: Record<string, string>; reference: string }[] } {
  const issues: InputIssue[] = unknownFields(body, ["inputs", "answer", "rows", "max_cost_usd", "answer_field", "effort"]);
  const columns = (key: "inputs"): string[] | null => {
    const v = body[key];
    if (!Array.isArray(v) || !v.length || v.length > COLUMNS_MAX || !v.every((c) => typeof c === "string" && c.length > 0 && c.length <= 200) || new Set(v).size !== v.length) {
      issues.push({ field: key, reason: v === undefined ? "missing" : "wrong_type", message: `${key} is the columns the agent is given: 1 to ${COLUMNS_MAX} distinct column names` });
      return null;
    }
    return v as string[];
  };
  const inputs = columns("inputs");
  const answer = body.answer;
  if (typeof answer !== "string" || !answer || answer.length > 200) issues.push({ field: "answer", reason: answer === undefined ? "missing" : "wrong_type", message: "answer is the column that holds the reference answer" });
  else if (inputs?.includes(answer)) issues.push({ field: "answer", reason: "not_allowed", message: "the answer column is no input column: the agent is never given the answer", fix: `Remove ${answer} from inputs.` });
  const field = body.answer_field;
  if (field !== undefined && (typeof field !== "string" || !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(field))) issues.push({ field: "answer_field", reason: "wrong_type", message: "answer_field is a dotted path into a JSON answer, such as result.code" });
  const cap = body.max_cost_usd;
  if (!(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) issues.push({ field: "max_cost_usd", reason: cap === undefined ? "missing" : "wrong_type", message: "max_cost_usd caps what the batch's runs spend (their jobs, look-backs and review turns), a number above 0" });
  // A run's effort as POST /agents/{id}/runs checks it (server.ts runBodyIssues), in its words: a typo is refused here, never
  // a batch whose every row fails.
  if (body.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(body.effort)) issues.push({ field: "effort", reason: "not_an_option", message: `effort is one of ${EFFORTS.join(", ")}` });
  const rows = body.rows;
  const parsed: { input: Record<string, string>; reference: string }[] = [];
  if (!Array.isArray(rows) || !rows.length) issues.push({ field: "rows", reason: rows === undefined ? "missing" : "wrong_type", message: "rows is a list of rows, each {column: text}" });
  else if (rows.length > BATCH_ROWS_MAX) issues.push({ field: "rows", reason: "too_long", message: `a batch holds at most ${BATCH_ROWS_MAX} rows` });
  else if (inputs && typeof answer === "string") {
    rows.forEach((row, i) => {
      const cell = (key: string): string | null => (isObject(row) && typeof row[key] === "string" && (row[key] as string).length <= BATCH_CELL_MAX ? (row[key] as string) : null);
      const cells: [string, string][] = [];
      for (const key of inputs) {
        const v = cell(key);
        if (v === null) return void issues.push({ field: `rows[${i}].${key}`, reason: "wrong_type", message: `row ${i + 1} has no text at ${key} (at most ${BATCH_CELL_MAX} characters)` });
        cells.push([key, v]);
      }
      // Own keys only (a column may be named __proto__: an assignment on {} would drop its text).
      const input: Record<string, string> = Object.fromEntries(cells);
      const reference = cell(answer);
      if (reference === null || !reference.trim()) return void issues.push({ field: `rows[${i}].${answer}`, reason: "missing", message: `row ${i + 1} has no reference answer at ${answer}` });
      parsed.push({ input, reference });
    });
  }
  if (issues.length || !inputs || typeof answer !== "string") return issues;
  return { inputs, answer, answer_field: typeof field === "string" ? field : null, effort: typeof body.effort === "string" ? body.effort : null, max_cost_usd: cap as number, rows: parsed };
}

const usd = (v: number) => Math.round(v * 1e6) / 1e6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
/** A run and its learning have stopped: ended, and its learning over (merged, dropped, none), or never begun on a run that
 *  did not complete (one stopped before its end-of-run turn keeps `seeded`: nothing more runs for it). */
const settled = (s: RunSnap) => TERMINAL.has(s.status) && s.ended_at !== null && (s.learning_state === null || s.learning_state === "merged" || s.learning_state === "dropped" || (s.status !== "completed" && s.learning_state === "seeded"));
/** How many times in a row a batch's loop may fail on the store (or a run's stop) and be taken up again from what the store
 *  holds, before the batch ends stopped on the error's words. */
const LOOP_TRIES = 5;
const words = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 400);
/** A row as a read shows it: no input (its run holds it), no review words, no revisions (the header's), and every text
 *  that can hold a value through `cut` (a lesson's name as the learning routes show one: notesView). */
const shownLessons = (l: Lessons, cut: Shown): Lessons => ({ notes: l.notes.map(cut.text), skills: l.skills.map(cut.name), workflows: l.workflows.map(cut.name) });
function shownRow({ input: _input, review: _review, revisions: _revisions, ...r }: Row, cut: Shown) {
  return {
    ...r,
    reference: cut.text(r.reference),
    ...(typeof r.answer === "string" ? { answer: cut.text(r.answer) } : {}),
    ...(r.learned ? { learned: shownLessons(r.learned, cut) } : {}),
    ...(r.error === undefined ? {} : { error: cut.text(r.error) }),
  };
}
const batchStage = (h: Header): keyof typeof BATCH_MOVES => (h.status !== "running" ? h.status : h.ending ? "ending" : "running");

/** A batch's loop in this process: `cancelled` (a person's cancel: the batch ends cancelled), `halted` (the server stopping:
 *  the loop lets go where it stands, the batch still running for the next start), `failed` (the loop failed LOOP_TRIES
 *  times: the batch ends stopped on these words). */
type Loop = { cancelled: boolean; halted: boolean; failed: string | null; done: Promise<void> };

/** The batches of one server: its running loops, and the store reads and writes. */
export class LearningBatches {
  private readonly loops = new Map<string, Loop>();
  private index: Promise<void> = Promise.resolve();
  private halting = false;
  constructor(private readonly host: BatchHost) {}

  private get settings() { return this.host.settings; }
  private get clock() { return this.host.now ?? Date.now; }
  private get pollMs() { return this.host.pollMs ?? 1_000; }
  private async header(id: string): Promise<Header | undefined> { return (await this.settings.get(HEAD(id))) as Header | undefined; }
  private async row(id: string, n: number): Promise<Row> { return (await this.settings.get(ROW(id, n))) as Row; }
  private async save(h: Header): Promise<void> { await this.settings.put(HEAD(h.id), h); }
  private async saveRow(id: string, row: Row): Promise<void> { await this.settings.put(ROW(id, row.n), row); }
  private ids = async (agentId: string): Promise<string[]> => ((await this.settings.get(INDEX(agentId))) as string[] | undefined) ?? [];

  /** Makes a batch of agent `agentId` and starts its loop. 409 when the agent does not learn or has a batch running. */
  async create(agentId: string, body: Record<string, unknown>): Promise<Header> {
    const checked = checkBatchBody(body);
    if (Array.isArray(checked)) throw invalid(checked);
    const learns = await this.host.learning(agentId);
    if (!learns.learns) throw new ApiError("agent_not_runnable", `The agent ${agentId} does not learn here: ${learns.why}`, { details: { learning: false } });
    // A batch whose progress would be withheld is never started.
    await this.host.shown(agentId);
    let made!: Header;
    // The index and the running check are one step, so two creates never both start (one process: a queue, not a lock).
    const step = this.index.then(async () => {
      const ids = await this.ids(agentId);
      for (const other of ids.slice(-5)) if ((await this.header(other))?.status === "running") throw new ApiError("agent_not_runnable", `The agent ${agentId} has a learning batch running (${other}): learning is ordered, so one batch runs at a time. Cancel it, or wait for it.`, { details: { batch_id: other } });
      const id = `lb_${randomBytes(8).toString("hex")}`;
      const now = new Date(this.clock()).toISOString();
      made = { id, agent_id: agentId, created_at: now, ended_at: null, status: "running", stopped: null, inputs: checked.inputs, answer: checked.answer, answer_field: checked.answer_field, effort: checked.effort, max_cost_usd: checked.max_cost_usd, total: checked.rows.length, finished: 0, right: 0, wrong: 0, failed: 0, spent_usd: 0, unknown_cost_rows: 0, paths: { agent: 0, handed_back: 0, workflow: 0 }, lessons: { notes: [], skills: [], workflows: [] }, revisions: [] };
      // The index first, the header last: a batch is made (and runs, and a start takes it up) only once its header is
      // saved, and by then the list and the running check find it. A stop before that leaves an id with no header, which
      // nothing shows, runs or counts.
      await this.settings.put(INDEX(agentId), [...ids, id]);
      for (const [i, r] of checked.rows.entries()) await this.saveRow(id, { n: i + 1, state: "pending", input: r.input, reference: r.reference });
      await this.save(made);
    });
    this.index = step.catch(() => undefined);
    await step;
    this.arm(made.id);
    return made;
  }

  /** The server started: every batch still running takes up where it stopped (an ending one, where its ending stands). */
  async resume(): Promise<number> {
    let n = 0;
    for (const { key, value } of await this.settings.all()) {
      if (!/^learning_batch\/lb_[0-9a-f]{16}$/.test(key)) continue;
      if ((value as Header).status === "running") { this.arm((value as Header).id); n++; }
    }
    return n;
  }

  /** A batch whole as progress: its header, what is under way and what it costs now, and its rows (no input: the run holds
   *  it), every text through the agent's cut now (host.shown). The cost now is the finished rows' and the live row's figures
   *  so far, by the function that books it (figures). */
  async read(agentId: string, id: string): Promise<Record<string, unknown>> {
    const h = await this.need(agentId, id);
    const cut = await this.host.shown(agentId);
    const rows: Row[] = [];
    for (let n = 1; n <= h.total; n++) rows.push(await this.row(id, n));
    const live = rows.find((r) => LIVE.has(stageOf(r)) && r.run_id);
    const inflight = live?.run_id ? ((await this.host.figures(live.run_id).catch(() => undefined))?.total_usd ?? null) : 0;
    return { ...this.shown(h, cut), current: live?.n ?? null, cost_usd: inflight === null || h.unknown_cost_rows ? null : usd(h.spent_usd + inflight), rows: rows.map((r) => shownRow(r, cut)) };
  }

  /** A batch as the header says it, for a list (no rows), its text through `cut`. A finished row whose cost is not known
   *  makes the cost, and what is left of the cap, unknown (null): the known part is never shown as the whole. */
  private shown(h: Header, cut: Shown) {
    const { ending: _ending, error, ...shown } = h;
    const known = h.unknown_cost_rows === 0;
    return {
      ...shown,
      inputs: h.inputs.map(cut.name),
      answer: cut.name(h.answer),
      answer_field: h.answer_field === null ? null : cut.name(h.answer_field),
      lessons: shownLessons(h.lessons, cut),
      revisions: h.revisions.map((r) => ({ ...r, workflows: r.workflows.map(cut.name) })),
      ...(error === undefined ? {} : { error: cut.text(error) }),
      cost_usd: known ? h.spent_usd : null,
      remaining_usd: known ? usd(Math.max(0, h.max_cost_usd - h.spent_usd)) : null,
    };
  }

  async list(agentId: string): Promise<{ batches: ReturnType<LearningBatches["shown"]>[] }> {
    const cut = await this.host.shown(agentId);
    const out = [];
    for (const id of (await this.ids(agentId)).slice(-20).reverse()) { const h = await this.header(id); if (h) out.push(this.shown(h, cut)); }
    return { batches: out };
  }

  /** A person's cancel: the batch's loop ends it cancelled, its live row's run stopped and booked first; answers once it has,
   *  as a read does. The cancel stands even when its answer is withheld (a 403 from the cut): stopping spend never waits on
   *  a sign-in. */
  async cancel(agentId: string, id: string): Promise<Record<string, unknown>> {
    const h = await this.need(agentId, id);
    if (h.status === "running" && !this.halting) {
      const loop = this.arm(id);
      loop.cancelled = true;
      await loop.done;
    }
    return this.read(agentId, id);
  }

  /** The server is stopping: every loop lets go where it stands, its batch still running (resume takes it up). */
  async halt(): Promise<void> {
    this.halting = true;
    const all = [...this.loops.values()];
    for (const loop of all) loop.halted = true;
    await Promise.all(all.map((loop) => loop.done));
  }

  /** Waits for a batch's loop to end (a test's and a shutdown's). */
  async idle(id: string): Promise<void> { await this.loops.get(id)?.done; }

  private async need(agentId: string, id: string): Promise<Header> {
    const h = BATCH_ID.test(id) ? await this.header(id) : undefined;
    if (!h || h.agent_id !== agentId) throw new ApiError("not_found", `no learning batch ${id} of agent ${agentId}`);
    return h;
  }

  /** The batch's loop in this process, started if it has none. A loop that fails (the store, a run's stop) is taken up again
   *  from what the store holds, LOOP_TRIES times, then ends its batch stopped on the error's words: never by letting the
   *  batch go with its row's run still going (the batch stays running, and owned, until its ending has stopped that run). */
  private arm(id: string): Loop {
    const had = this.loops.get(id);
    if (had) return had;
    const loop: Loop = { cancelled: false, halted: this.halting, failed: null, done: Promise.resolve() };
    this.loops.set(id, loop);
    loop.done = (async () => {
      for (let tries = 1; ; tries++) {
        try {
          return await this.loop(id, loop);
        } catch (error) {
          if (loop.halted) return;
          if (tries >= LOOP_TRIES) loop.failed ??= words(error);
          await sleep(Math.min(30_000, this.pollMs * 2 ** tries));
        }
      }
    })().finally(() => void this.loops.delete(id));
    return loop;
  }

  /** The batch machine from where the store has it: a running batch takes its rows in order until one of them, or the cap,
   *  the agent's learning, a cancel or a failure, ends it (`ending`); an ending batch stops its live row and ends. */
  private async loop(id: string, loop: Loop): Promise<void> {
    // The header's figures folded from the rows as saved (a server that stopped between a row's write and its header's
    // books it here, once).
    let h = await this.tally((await this.header(id))!);
    if (batchStage(h) !== "running" && batchStage(h) !== "ending") return;
    if (loop.failed && !h.ending) h = await this.ending(h, { status: "stopped", stopped: null, error: loop.failed });
    // A row booked with its cost unknown stops the batch, read from the rows: a stop between that row's write and the
    // batch's ending is no batch that runs on, or completes.
    if (h.unknown_cost_rows && !h.ending) h = await this.ending(h, { status: "stopped", stopped: "cost_unknown" });
    for (let n = 1; n <= h.total && !h.ending; n++) {
      if (loop.halted) return;
      if (loop.cancelled) break;
      let row = await this.row(id, n);
      const stage = stageOf(row);
      if (stage === "done" || stage === "failed") continue;
      if (stage === "pending") {
        // A run started under the row's key before its row kept the id is that row's run: never a second.
        const found = await this.host.find(ROW_KEY(id, n));
        if (found) row = await this.move(id, row, "started", { run_id: found });
        else {
          const room = this.room(h);
          if (room !== true) { h = await this.ending(h, { status: "stopped", stopped: room }); break; }
          // Learning is checked again before every row: an agent (or a server) that stopped learning runs no row unlearned.
          const learns = await this.host.learning(h.agent_id);
          if (!learns.learns) { h = await this.ending(h, { status: "stopped", stopped: "learning_off", error: `The agent does not learn here: ${learns.why}` }); break; }
        }
      }
      h = await this.runRow(h, row, loop);
      if (loop.halted) return;
      if (h.unknown_cost_rows && !loop.cancelled) { h = await this.ending(h, { status: "stopped", stopped: "cost_unknown" }); break; }
    }
    if (loop.halted) return;
    if (!h.ending) h = await this.ending(h, loop.cancelled ? { status: "cancelled", stopped: null } : { status: "completed", stopped: null });
    await this.finish(h, loop);
  }

  /** Whether another row may start: the cap's room covers the mean total of the rows done, and a run's own smallest cap (a
   *  run capped under a cent cannot take a step: cap.ts), so a row's run is never started to pause at its cap. */
  private room(h: Header): true | BatchStop {
    if (h.unknown_cost_rows) return "cost_unknown";
    const left = usd(h.max_cost_usd - h.spent_usd);
    const done = h.finished - h.unknown_cost_rows;
    const typical = done > 0 ? usd(h.spent_usd / done) : 0;
    return left >= Math.max(typical, RUN_CAP_MIN_USD) ? true : "cap";
  }

  /** running -> ending: how the batch ends, one write, before its live row is stopped. */
  private async ending(h: Header, ending: Ending): Promise<Header> {
    if (batchStage(h) !== "running") throw new Error(`batch ${h.id} cannot end from ${batchStage(h)}`);
    const next: Header = { ...h, ending };
    await this.save(next);
    return next;
  }

  /** ending -> completed, cancelled or stopped: every live row's run stopped and booked failed (on the ending's words), then
   *  the header's one write. A server stopping meanwhile leaves the batch ending, for the next start to finish. */
  private async finish(h: Header, loop: Loop): Promise<void> {
    const ending = h.ending!;
    const why = ending.error ?? (ending.status === "cancelled" ? "the batch was cancelled" : "the batch stopped before this row ended");
    for (let n = 1; n <= h.total; n++) {
      const row = await this.row(h.id, n);
      if (!LIVE.has(stageOf(row))) continue;
      h = await this.fail(h, row, why, loop);
      if (loop.halted) return;
    }
    const { ending: _ending, ...rest } = await this.tally(h);
    if (!BATCH_MOVES.ending.includes(ending.status)) throw new Error(`batch ${h.id} cannot end ${ending.status}`);
    await this.save({ ...rest, status: ending.status, stopped: ending.stopped, ...(ending.error ? { error: ending.error } : {}), ended_at: new Date(this.clock()).toISOString() });
  }

  /** One row's move: allowed by ROW_MOVES, one write of its record. */
  private async move(id: string, row: Row, to: Stage, patch: Partial<Row>): Promise<Row> {
    const from = stageOf(row);
    if (!ROW_MOVES[from].includes(to)) throw new Error(`row ${row.n} of batch ${id} cannot go from ${from} to ${to}`);
    const next: Row = { ...row, ...patch, state: to === "done" || to === "failed" ? to : "running" };
    if (stageOf(next) !== to) throw new Error(`row ${row.n} of batch ${id} wrote ${stageOf(next)} for ${to}`);
    await this.saveRow(id, next);
    return next;
  }

  /** Waits until `until` holds of the run's view. A view that fails is looked at again (a read is no ending); a cancel or a
   *  halt ends the wait ("stop": the row stays live, for the batch's ending or the next start), and so does the row's time. */
  private async wait(runId: string, until: (s: RunSnap) => boolean, loop: Loop): Promise<RunSnap | "stop" | "timeout"> {
    const started = this.clock();
    for (;;) {
      if (loop.cancelled || loop.halted) return "stop";
      const s = await this.host.view(runId).catch(() => undefined);
      if (s && until(s)) return s;
      if (this.clock() - started > (this.host.rowTimeoutMs ?? 30 * 60_000)) return "timeout";
      await sleep(this.pollMs);
    }
  }

  /** A row's every move from where its record stands: its run (started under the row's key), its answer (written once), the
   *  review (sent once), the review's turn and look-back, the booking. Returns the header folded once the row ended; a cancel
   *  or a halt leaves it live (the batch's ending stops it, or the next start takes it up). */
  private async runRow(h: Header, row: Row, loop: Loop): Promise<Header> {
    if (stageOf(row) === "pending") {
      const key = ROW_KEY(h.id, row.n);
      let runId: string | undefined;
      try {
        runId = await this.host.start(h.agent_id, { input: { content: contentOf(h.inputs, row.input) }, max_cost_usd: usd(h.max_cost_usd - h.spent_usd), ...(h.effort ? { effort: h.effort } : {}) }, key);
      } catch (error) {
        // A start that failed after its run was made is that run's start: found by the key, the row is its.
        runId = await this.host.find(key);
        if (!runId) return this.fail(h, row, `the run did not start: ${words(error)}`, loop);
      }
      row = await this.move(h.id, row, "started", { run_id: runId });
    }
    const runId = row.run_id!;
    if (loop.cancelled || loop.halted) return h;

    // Its answer: its end, and its learning's. A person's wait (a question, a paused cap) is a failed row.
    if (stageOf(row) === "started") {
      const snap = await this.wait(runId, (s) => s.status === "input_required" || settled(s), loop);
      if (snap === "stop") return h;
      if (snap === "timeout") return this.fail(h, row, "the run did not end in time", loop);
      if (snap.status === "input_required") return this.fail(h, row, "the run waits on a person: a batch's runs ask no one", loop);
      if (snap.status !== "completed") return this.fail(h, row, snap.error ?? `the run ${snap.status}`, loop);
      const whole = answerValue(snap.answer, h.answer_field);
      // The path is the job's, read now, before the review's message is in the run (the run's answer is the job's).
      const job = await this.host.figures(runId);
      row = await this.move(h.id, row, "answered", { answer: whole === null ? null : whole.slice(0, ANSWER_SHOWN), right: matches(whole, row.reference), review_after: snap.ended_at, review: reviewText(row.reference, whole), ...(job ? { path: job.path } : {}) });
    }

    // The review: once (a resume finds it in the run's commands), to a completed run whose learning has settled.
    if (stageOf(row) === "answered") {
      const review = row.review!;
      try {
        if (!(await this.host.sent(runId, review))) await this.host.message(runId, review);
      } catch (error) {
        return this.fail(h, row, `the review was not sent: ${words(error)}`, loop);
      }
      row = await this.move(h.id, row, "reviewed", { reviewed: true });
    }

    // The review's turn, its new end and the look-back it makes: a row is done only once that turn completed and its run
    // learned from the reference.
    const after = row.review_after ?? null;
    const back = await this.wait(runId, (s) => s.status === "input_required" || (settled(s) && s.ended_at !== after), loop);
    if (back === "stop") return h;
    if (back === "timeout") return this.fail(h, row, "the review's turn did not end in time", loop);
    if (back.status === "input_required") return this.fail(h, row, "the run waits on a person after its review: a batch's runs ask no one", loop);
    if (back.status !== "completed") return this.fail(h, row, `the review's turn ${back.status === "cancelled" ? "was cancelled" : "failed"}${back.error ? `: ${back.error}` : ""}`, loop);
    const f = await this.host.figures(runId);
    await this.move(h.id, row, "done", f ? { cost_usd: f.cost_usd, learning_usd: f.learning_usd, total_usd: f.total_usd, learned: f.learned, merged: f.merged, revisions: f.revisions } : {});
    return this.tally(h);
  }

  /** A row ends failed: a live row's run is asked to stop (nothing to one that ended; a stop that fails is the loop's
   *  failure, so the row stays live and owned) and waited for, with its grade, before its figures are read; one that does not
   *  stop within settleMs leaves the row's cost unknown. A halt meanwhile leaves the row as it is, for the next start. */
  private async fail(h: Header, row: Row, error: string, loop: Loop): Promise<Header> {
    const runId = row.run_id;
    let known = true;
    if (runId) {
      const now = await this.host.view(runId).catch(() => undefined);
      if (!now || !settled(now)) await this.host.cancel(runId);
      const started = this.clock();
      for (let s = now; !(s && settled(s)); ) {
        if (loop.halted) return h;
        if (this.clock() - started > (this.host.settleMs ?? 10 * 60_000)) { known = false; break; }
        await sleep(this.pollMs);
        s = await this.host.view(runId).catch(() => undefined);
      }
    }
    const f = runId && known ? await this.host.figures(runId).catch(() => undefined) : undefined;
    await this.move(h.id, row, "failed", { error: error.slice(0, 400), total_usd: runId ? (f?.total_usd ?? null) : 0, ...(f ? { path: row.path ?? f.path, cost_usd: f.cost_usd, learning_usd: f.learning_usd, learned: f.learned, merged: f.merged, revisions: f.revisions } : {}) });
    return this.tally(h);
  }

  /** The header's figures folded from its rows as saved, then saved: counts, $, paths, lessons and the merges that touched
   *  workflows, each row once. Never added to, so a stop between a row's write and this one loses nothing. */
  private async tally(h: Header): Promise<Header> {
    const next: Header = { ...h, finished: 0, right: 0, wrong: 0, failed: 0, spent_usd: 0, unknown_cost_rows: 0, paths: { agent: 0, handed_back: 0, workflow: 0 }, lessons: { notes: [], skills: [], workflows: [] }, revisions: [] };
    let spent = 0;
    for (let n = 1; n <= h.total; n++) {
      const row = await this.row(h.id, n);
      if (row.state !== "done" && row.state !== "failed") continue;
      next.finished++;
      if (row.state === "failed") next.failed++;
      else if (row.right) next.right++;
      else if (row.right === false) next.wrong++;
      if (row.run_id && (row.total_usd === null || row.total_usd === undefined)) next.unknown_cost_rows++;
      spent += row.total_usd ?? 0;
      if (row.path) next.paths[row.path]++;
      for (const kind of ["notes", "skills", "workflows"] as const) for (const name of row.learned?.[kind] ?? []) if (!next.lessons[kind].includes(name)) next.lessons[kind].push(name);
      for (const r of row.revisions ?? []) next.revisions.push({ row: row.n, commit: r.commit, workflows: r.workflows });
    }
    next.spent_usd = usd(spent);
    if (h.status === "running") await this.save(next);
    return next;
  }
}
