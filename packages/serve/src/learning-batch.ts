// Learn from a CSV: a learning batch (POST /agents/{id}/learning/batches). A person gives rows, which columns are the input
// and which the answer, and a cap; the server runs the agent on each row in order with learning on, and after each run tells
// it the reference answer next to its own, the hindsight review the learning bench sends (learn-bench's follow-up: a message
// to the finished run, which looks back again). The batch's progress is the store's, never the browser's: a header per batch
// and one key per row in the server's settings (no table), each row's stage written before the next step, so a batch resumes
// where it stopped when the server starts again. One row at a time, since what a row teaches is what the next one is given.
// Nothing here knows a job: the input is the chosen columns as {column: value}, the match is structural equality (a display,
// not a judge: the learning grade is the judge), and the words of the review are generic.
import { randomBytes } from "node:crypto";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { EFFORTS } from "./model.js";
import { isObject, unknownFields } from "./validate.js";
import type { RunPath } from "./learning-cost.js";
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

type Lessons = { notes: string[]; skills: string[]; workflows: string[] };
/** One row as the store keeps it. `input` and `reference` are the person's; `answer` the run's, cut. */
export type Row = {
  n: number;
  state: RowState;
  input: Record<string, string>;
  reference: string;
  run_id?: string;
  /** The run's answer as compared (its answer_field's value when the batch names one), cut at ANSWER_SHOWN, and whether it is
   *  the reference: written once, when the run first answers, never again (the reply to the review is no answer). */
  answer?: string | null;
  right?: boolean;
  /** The run's end the review follows (its ended_at when it answered): the review's own end is a later one. */
  review_after?: string | null;
  /** The review was sent to the run (the run's commands hold it: a resume that finds it there sends none). */
  reviewed?: boolean;
  path?: RunPath;
  cost_usd?: number | null;
  learning_usd?: number | null;
  total_usd?: number | null;
  learned?: Lessons;
  /** The commit of the agent's learning folder the run's learning merged, when it did. */
  merged?: string | null;
  error?: string;
};

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
};

/** What the loop reads of a run, from the server's view of it. */
export type RunSnap = { status: string; ended_at: string | null; answer: string | null; cost_usd: number | null; learning_state: string | null; error: string | null };
/** What a finished run's learning and cost say (store-reads/learning.ts costRunOf, runLearningEnd). */
export type Figures = { path: RunPath; cost_usd: number | null; learning_usd: number | null; total_usd: number | null; learned: Lessons; merged: string | null };

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
  cancel(runId: string): Promise<void>;
  figures(runId: string): Promise<Figures | undefined>;
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
/** The review a run is sent: the same words right or wrong. */
export const reviewText = (reference: string, answer: string | null): string => `Review: the reference answer is "${reference}"; you answered "${answer ?? "nothing"}".`;

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
  if (!(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) issues.push({ field: "max_cost_usd", reason: cap === undefined ? "missing" : "wrong_type", message: "max_cost_usd is the most the whole batch spends, a number above 0: the runs and what learning adds" });
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

/** A running batch's loop: `cancelled` ends it (a person's cancel, or the server stopping: `halted`, which leaves the batch running for the next start). */
type Loop = { cancelled: boolean; halted: boolean; done: Promise<void>; current: string | null };

/** The batches of one server: its running loops, and the store reads and writes. */
export class LearningBatches {
  private readonly loops = new Map<string, Loop>();
  private index: Promise<void> = Promise.resolve();
  constructor(private readonly host: BatchHost) {}

  private get settings() { return this.host.settings; }
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
    let made!: Header;
    // The index and the running check are one step, so two creates never both start (one process: a queue, not a lock).
    const step = this.index.then(async () => {
      const ids = await this.ids(agentId);
      for (const other of ids.slice(-5)) if ((await this.header(other))?.status === "running") throw new ApiError("agent_not_runnable", `The agent ${agentId} has a learning batch running (${other}): learning is ordered, so one batch runs at a time. Cancel it, or wait for it.`, { details: { batch_id: other } });
      const id = `lb_${randomBytes(8).toString("hex")}`;
      const now = new Date((this.host.now ?? Date.now)()).toISOString();
      made = { id, agent_id: agentId, created_at: now, ended_at: null, status: "running", stopped: null, inputs: checked.inputs, answer: checked.answer, answer_field: checked.answer_field, effort: checked.effort, max_cost_usd: checked.max_cost_usd, total: checked.rows.length, finished: 0, right: 0, wrong: 0, failed: 0, spent_usd: 0, unknown_cost_rows: 0, paths: { agent: 0, handed_back: 0, workflow: 0 }, lessons: { notes: [], skills: [], workflows: [] }, revisions: [] };
      for (const [i, r] of checked.rows.entries()) await this.saveRow(id, { n: i + 1, state: "pending", input: r.input, reference: r.reference });
      await this.save(made);
      await this.settings.put(INDEX(agentId), [...ids, id]);
    });
    this.index = step.catch(() => undefined);
    await step;
    this.arm(made.id);
    return made;
  }

  /** The server started: every batch still running takes up where it stopped. */
  async resume(): Promise<number> {
    let n = 0;
    for (const { key, value } of await this.settings.all()) {
      if (!/^learning_batch\/lb_[0-9a-f]{16}$/.test(key)) continue;
      if ((value as Header).status === "running") { this.arm((value as Header).id); n++; }
    }
    return n;
  }

  /** A batch whole as progress: its header, what is under way and what it costs now, and its rows (no input: the run holds it). */
  async read(agentId: string, id: string): Promise<Record<string, unknown>> {
    const h = await this.need(agentId, id);
    const rows: Row[] = [];
    for (let n = 1; n <= h.total; n++) rows.push(await this.row(id, n));
    const live = rows.find((r) => r.state === "running" && r.run_id);
    const inflight = live?.run_id ? ((await this.host.view(live.run_id))?.cost_usd ?? null) : 0;
    return { ...this.shown(h), current: live?.n ?? null, cost_usd: inflight === null ? null : usd(h.spent_usd + inflight), rows: rows.map(({ input: _input, ...r }) => r) };
  }

  /** A batch as the header says it, for a list (no rows). */
  private shown(h: Header) { return { ...h, cost_usd: h.spent_usd, remaining_usd: usd(Math.max(0, h.max_cost_usd - h.spent_usd)) }; }

  async list(agentId: string): Promise<{ batches: ReturnType<LearningBatches["shown"]>[] }> {
    const out = [];
    for (const id of (await this.ids(agentId)).slice(-20).reverse()) { const h = await this.header(id); if (h) out.push(this.shown(h)); }
    return { batches: out };
  }

  async cancel(agentId: string, id: string): Promise<Record<string, unknown>> {
    const h = await this.need(agentId, id);
    const loop = this.loops.get(id);
    if (h.status === "running" && loop) {
      loop.cancelled = true;
      if (loop.current) await this.host.cancel(loop.current).catch(() => undefined);
      await loop.done;
    }
    return this.read(agentId, id);
  }

  /** The server is stopping: every loop ends where it stands, its batch still running (resume takes it up). */
  async halt(): Promise<void> {
    const all = [...this.loops.values()];
    for (const loop of all) { loop.halted = true; loop.cancelled = true; }
    await Promise.all(all.map((loop) => loop.done));
  }

  /** Waits for a batch's loop to end (a test's and a shutdown's). */
  async idle(id: string): Promise<void> { await this.loops.get(id)?.done; }

  private async need(agentId: string, id: string): Promise<Header> {
    const h = BATCH_ID.test(id) ? await this.header(id) : undefined;
    if (!h || h.agent_id !== agentId) throw new ApiError("not_found", `no learning batch ${id} of agent ${agentId}`);
    return h;
  }

  private arm(id: string): void {
    if (this.loops.has(id)) return;
    const loop: Loop = { cancelled: false, halted: false, current: null, done: Promise.resolve() };
    loop.done = this.loop(id, loop).catch(async (error) => {
      // The loop itself failing (the store, not a row) ends the batch stopped on the error's words, never silently.
      const h = await this.header(id).catch(() => undefined);
      if (h && h.status === "running" && !loop.halted) await this.save({ ...h, status: "stopped", stopped: null, ended_at: new Date().toISOString(), error: String((error as Error)?.message ?? error).slice(0, 400) }).catch(() => undefined);
    }).finally(() => void this.loops.delete(id));
    this.loops.set(id, loop);
  }

  private async loop(id: string, loop: Loop): Promise<void> {
    // The header's figures folded from the rows as saved (a server that stopped between a row's write and its header's
    // books it here, once).
    let h = await this.tally((await this.header(id))!);
    for (let n = 1; n <= h.total; n++) {
      if (loop.cancelled) break;
      const row = await this.row(id, n);
      if (row.state === "done" || row.state === "failed") continue;
      if (!row.run_id) {
        // A run started under the row's key before its row kept the id is that row's run: never a second.
        row.run_id = await this.host.find(ROW_KEY(id, n));
        if (row.run_id) { row.state = "running"; await this.saveRow(id, row); }
      }
      if (!row.run_id) {
        const room = this.room(h);
        if (room !== true) { h = await this.end(h, "stopped", room); return; }
        // Learning is checked again before every row: an agent (or a server) that stopped learning runs no row unlearned.
        const learns = await this.host.learning(h.agent_id);
        if (!learns.learns) { h = await this.end({ ...h, error: `The agent does not learn here: ${learns.why}` }, "stopped", "learning_off"); return; }
      }
      h = await this.runRow(h, row, loop);
      if (loop.cancelled) break;
      if (h.unknown_cost_rows) { h = await this.end(h, "stopped", "cost_unknown"); return; }
    }
    // The server stopping leaves the batch running: it takes up again when the server starts.
    if (loop.halted) return;
    await this.end(h, loop.cancelled ? "cancelled" : "completed", null);
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

  private async end(h: Header, status: BatchStatus, stopped: BatchStop | null): Promise<Header> {
    const ended = { ...h, status, stopped, ended_at: new Date((this.host.now ?? Date.now)()).toISOString() };
    await this.save(ended);
    return ended;
  }

  /** One row, as a machine whose every step is saved before the next and safe to take again after a stop: its run (started
   *  under the row's key: find), its answer (written once), the review (sent once: sent), the review's look-back, the
   *  booking (folded: tally). Every ending short of done stops its run and waits for it and its grade to stop first. */
  private async runRow(h: Header, row: Row, loop: Loop): Promise<Header> {
    const clock = this.host.now ?? Date.now;
    // A run and its learning have stopped: ended, and its learning over (merged, dropped, none), or never begun on a run
    // that did not complete (one stopped before its end-of-run turn keeps `seeded`: nothing more runs for it).
    const settled = (s: RunSnap) => TERMINAL.has(s.status) && s.ended_at !== null && (s.learning_state === null || s.learning_state === "merged" || s.learning_state === "dropped" || (s.status !== "completed" && s.learning_state === "seeded"));
    const wait = async (until: (s: RunSnap) => boolean, runId: string): Promise<RunSnap | "cancelled" | "timeout"> => {
      const started = clock();
      for (;;) {
        if (loop.cancelled) return "cancelled";
        const s = await this.host.view(runId);
        if (s && until(s)) return s;
        if (clock() - started > (this.host.rowTimeoutMs ?? 30 * 60_000)) return "timeout";
        await sleep(this.host.pollMs ?? 1_000);
      }
    };
    /** The row failed: its run stopped (`stop`: cancelled first) and waited for, with its grade, before its cost is read; a
     *  run that does not stop in time leaves the row's cost unknown (and the batch stops). A server stopping meanwhile
     *  leaves the row as it is, for the next start to end. */
    const fail = async (error: string, stop: boolean): Promise<Header> => {
      const runId = row.run_id;
      let known = true;
      if (runId) {
        if (stop) await this.host.cancel(runId).catch(() => undefined);
        const started = clock();
        for (;;) {
          if (loop.halted) return h;
          const s = await this.host.view(runId).catch(() => undefined);
          if (s && settled(s)) break;
          if (clock() - started > (this.host.settleMs ?? 10 * 60_000)) { known = false; break; }
          await sleep(this.host.pollMs ?? 1_000);
        }
      }
      const f = runId && known ? await this.host.figures(runId).catch(() => undefined) : undefined;
      const failed: Row = { ...row, state: "failed", error: error.slice(0, 400), total_usd: runId ? (f?.total_usd ?? null) : 0, ...(f ? { path: f.path, cost_usd: f.cost_usd, learning_usd: f.learning_usd, learned: f.learned, merged: f.merged } : {}) };
      return this.close(h, failed, loop);
    };
    const ended = (why: string) => (loop.halted ? h : fail(why, true));

    if (!row.run_id) {
      const remaining = usd(h.max_cost_usd - h.spent_usd);
      try {
        row.run_id = await this.host.start(h.agent_id, { input: { content: contentOf(h.inputs, row.input) }, max_cost_usd: remaining, ...(h.effort ? { effort: h.effort } : {}) }, ROW_KEY(h.id, row.n));
      } catch (error) {
        return fail(`the run did not start: ${(error as Error)?.message ?? error}`, false);
      }
      row.state = "running";
      await this.saveRow(h.id, row);
    }
    const runId = row.run_id!;
    loop.current = runId;
    // A cancel that came while the run was starting (before it had an id to stop) stops it now.
    if (loop.cancelled) return ended("the batch was cancelled");

    // Its answer: its end, and its learning's. A person's wait (a question, a paused cap) is a failed row, cancelled.
    if (row.right === undefined) {
      const snap = await wait((s) => s.status === "input_required" || settled(s), runId);
      if (snap === "cancelled") return ended("the batch was cancelled");
      if (snap === "timeout") return fail("the run did not end in time", true);
      if (snap.status === "input_required") return fail("the run waits on a person: a batch's runs ask no one", true);
      if (snap.status !== "completed") return fail(snap.error ?? `the run ${snap.status}`, false);
      const shown = answerValue(snap.answer, h.answer_field);
      row.answer = shown === null ? null : shown.slice(0, ANSWER_SHOWN);
      row.right = matches(shown, row.reference);
      row.review_after = snap.ended_at;
      await this.saveRow(h.id, row);
    }

    // The review: once (a resume finds it in the run's commands), to a completed run whose learning has settled.
    if (!row.reviewed) {
      const words = reviewText(row.reference, row.answer ?? null);
      try {
        if (!(await this.host.sent(runId, words))) await this.host.message(runId, words);
      } catch (error) {
        return fail(`the review was not sent: ${(error as Error)?.message ?? error}`, false);
      }
      row.reviewed = true;
      await this.saveRow(h.id, row);
    }

    // The review's new end and the look-back it makes: a row is done only once its run learned from the reference.
    const after = row.review_after ?? null;
    const back = await wait((s) => s.status === "input_required" || (settled(s) && s.ended_at !== after), runId);
    if (back === "cancelled") return ended("the batch was cancelled");
    if (back === "timeout") return fail("the review's look-back did not end in time", true);
    if (back.status === "input_required") return fail("the run waits on a person after its review: a batch's runs ask no one", true);
    const f = await this.host.figures(runId);
    const done: Row = { ...row, state: "done", ...(f ? { path: f.path, cost_usd: f.cost_usd, learning_usd: f.learning_usd, total_usd: f.total_usd, learned: f.learned, merged: f.merged } : {}) };
    return this.close(h, done, loop);
  }

  /** The row ended: saved, then the header folded from the rows. */
  private async close(h: Header, row: Row, loop: Loop): Promise<Header> {
    await this.saveRow(h.id, row);
    loop.current = null;
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
      if (row.learned?.workflows.length) next.revisions.push({ row: row.n, commit: row.merged ?? null, workflows: row.learned.workflows });
    }
    next.spent_usd = usd(spent);
    await this.save(next);
    return next;
  }
}
