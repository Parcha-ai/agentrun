// A run's learning, a step the kernel calls. runs.ts owns a run's process, its door, its rows and its serve.json; it
// builds one LearningRuns and calls it where a run's life meets learning:
//   onStart       the run about to be made: its seed read first, then pinned in it once it is (learning.ts)
//   onSaved       its serve.json written: the learning ledger's line, once its learning ended (usage.ts)
//   onLoad        a run read at a start, before the kernel holds it: a seed copy a server went down during taken back
//   beforeFinish  its job ended: the end-of-run turn asked first, and the run let go once the turn ends
//   onAdopt       a running run read at a start: one a server left in its end-of-run turn finishes, its turn asked again
//   onLaunch      its process launched: the saved keys it was handed, kept for the check of what its turn writes
//   beforeSettle  its end being written: the turn's rows closed, and what the turn wrote set aside
//   afterSettle   its end written: what the turn wrote checked (propose.ts), graded and merged (grade.ts)
//   onReopen, afterReopen   a follow-up: its copy laid again, and a turn its process went in aborted
//   recover       the server's start: what a server left between steps, picked up once
//   close, idle   the server closing: grades stopped, then every check and grade in flight waited for
// It holds the runs' learning in flight; a run's learning itself is in its serve.json (`learning`, `reflect`), which
// the kernel writes.
import { lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { INDEX_FILE, parseNoteFile, redactSecrets, type Verdict } from "./learn/index.js";
import type { AnalyticsFilter, Revision, RunRow, StartedRun } from "@parcha/pi-durable-agent";
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { CAP_REFUSAL_PREFIX, SPEND_CAP_REACHED } from "./cap.js";
import { readJson, RUN_META } from "./files.js";
import { activeOf, detailShown, dropSeed, KEPT_LEARNING, layLearned, LEARNED_DIR, type Learning, LEARNING_LABEL, learningBlocker, type LearningReason, type LearningState, learningTestHooks, learningView, type NoteLearned, pinSeed, type Proposal, PROPOSAL, readPin, type Seed, seedAt, seedOf, secretsShown, shortLearning, type Shown, snapshotLearned, withAgentGrade } from "./learning.js";
import { withoutFaux } from "./model.js";
import type { Run, RunsOptions, Status } from "./runs.js";
import { hostSecrets, secret, SECRET_NAMES, withSecrets } from "./secrets.js";
import { notKept, said, STOPPED } from "./learning-words.js";
import { ended, outcomeOf, outcomes, record } from "./usage.js";
import { isObject, type Json } from "./validate.js";

/** A run's end-of-run turn: the job's outcome, the newest store entry before the turn and, once the run ended, the newest
 *  after it (its rows are those between), its deadline, whether its copy of the folder was laid, and how it ended. */
export type Reflect = { outcome: Status; after: number; until?: number; deadline: string; laid?: true; ended?: true; timedOut?: true };
/** Who sent the end-of-run turn: the server, never a person, and no request field sets it. The one value it is sent
 *  with, at its one call (reflectTurn); the per-tool gate, once this server has one, takes it there. */
const REFLECT_ORIGIN = "reflect";
export type TurnOrigin = typeof REFLECT_ORIGIN;
/** The run asked its end-of-run turn and has not ended since. */
export const reflecting = (run: { meta: { reflect?: Reflect } }) => run.meta.reflect !== undefined && run.meta.reflect.until === undefined;
/** The run ended after its end-of-run turn did, and what the turn wrote is neither checked nor dropped yet. */
const awaitsPropose = (meta: Partial<Run["meta"]> | null): boolean => meta?.learning?.state === "reflecting" && meta.reflect?.ended === true && meta.reflect.until !== undefined;
/** The end-of-run turn's request id: the door and pi take one id once, so a turn asked again after a restart is not
 *  asked twice. */
const reflectId = (runId: string) => `learn-reflect-${runId}`;
/** How long a run's end-of-run turn may take before it is aborted and the run finishes without it. */
const REFLECT_TIMEOUT_MS = 5 * 60_000;
/** How often the run's door is asked whether its end-of-run turn has ended. */
const REFLECT_POLL_MS = 250;
/** A row's store entry, from its id (`<conversation>:<entry>[:...]`); NaN for a row no entry made (a live one, usage). */
const entryOf = (id: string) => Number(id.split(":")[1]);
/** Whether entry `id` (a number), or the row `id`, is the end-of-run turn's. Before the run has ended every later entry
 *  is, and so is a live row. */
export function reflects(reflect: Reflect | undefined, id: string | number): boolean {
  if (!reflect) return false;
  const entry = typeof id === "number" ? id : entryOf(id);
  if (Number.isInteger(entry)) return entry > reflect.after && (reflect.until === undefined || entry <= reflect.until);
  return reflect.until === undefined && typeof id === "string" && id.includes(":live:");
}
/** `rows` with the end-of-run turn's labelled: never the run's answer (meaningful skips the label), its answer shown as
 *  a text row, and its message as the host's, in a person's words (learning-words.ts): what the model is asked stays in
 *  the run's store, and no row shows it. */
export function labelled(reflect: Reflect | undefined, rows: TimelineEvent[]): TimelineEvent[] {
  if (!reflect) return rows;
  return rows.map((row) => (!reflects(reflect, row.id) ? row : {
    ...row, agent_label: LEARNING_LABEL,
    ...(row.kind === "final_answer" ? { kind: "text_block" as const } : {}),
    ...(row.kind === "user_message" ? { summary: said.asked, text: said.asked } : {}),
  }));
}
/** A path that names a file at the top of a run's copy of the folder: `.learning/<file>` relative to its work, as a
 *  harness's file tools take it, or the same at the end of an absolute path (claude-agent's CLI joins its working
 *  directory; a box names its own). */
const IN_COPY = new RegExp(`(?:^|/)${LEARNED_DIR.replace(".", "\\.")}/([^/]+)$`);
/** The files of the run's copy of the folder its job read, in the order it first read them, each once: every `read`
 *  call whose result came back a success, matched to its call by id (claude-agent's rows can hold the result above the
 *  call), on any harness: pi's, claude-agent's (the host's `read`, served to its CLI as `mcp__hands__read`) and codex's
 *  (the same tool, as an app-server dynamic tool) rows all name it `read`, with the path as the model gave it. The
 *  end-of-run turn's reads are its own, not the job's, and are left out; so is a read that failed or never ended, and
 *  MEMORY.md, which is no note. Which of these files are notes the run started from is for its seed to say (noteUsed). */
export function notesRead(reflect: Reflect | undefined, rows: readonly TimelineEvent[]): string[] {
  const done = new Set(rows.flatMap((row) => (row.kind === "tool_result" && row.tool_status === "success" && row.tool_use_id ? [row.tool_use_id] : [])));
  const read = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "tool_use" || row.tool_name !== "read" || !row.tool_use_id || !done.has(row.tool_use_id) || reflects(reflect, row.id)) continue;
    const file = IN_COPY.exec(posix.normalize(row.tool_input_preview ?? ""))?.[1];
    if (file && file !== INDEX_FILE) read.add(file);
  }
  return [...read];
}

/** `verdict` with its reason, and each item's question and why, cut of `values` (learn/secrets.ts redactSecrets). */
const cutVerdict = (verdict: Verdict, values: readonly string[]): Verdict => ({
  ...verdict,
  reason: redactSecrets(verdict.reason, values),
  items: verdict.items.map((item) => ({ ...item, ...(item.question === undefined ? {} : { question: redactSecrets(item.question, values) }), why: redactSecrets(item.why, values) })),
});

/** The notes a run's learning added, from its proposal: each note's file, name and the notes it supersedes. */
const learnedOf = (proposal: Proposal): NoteLearned[] => proposal.notes.flatMap(({ file, text }) => {
  const note = parseNoteFile(file, text);
  return Array.isArray(note) ? [] : [{ file, name: note.name, supersedes: note.supersedes }];
});

/** The run's learning row, once its learning was proposed, merged or dropped (`seed_failed` included): its state, reason
 *  and detail, its summary the detail itself as the run's view says it (learning.ts detailShown: cut of the host's
 *  secrets now, `shown`, then cut short). One row, which says where the learning ended. */
export function withLearning(rows: readonly TimelineEvent[], learning: Learning | undefined, shown: Shown): TimelineEvent[] {
  if (!learning || learning.state === "seeded" || learning.state === "reflecting") return [...rows];
  const detail = detailShown(learning, shown);
  const row = {
    id: LEARNING_LABEL, timestamp: learning.at, created_at: learning.at, kind: "learning" as const, summary: detail ?? `Learning ${learning.state}`, agent_label: LEARNING_LABEL,
    tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: detail,
    learning: { state: learning.state, reason: learning.reason, detail },
  };
  return [...rows, row];
}

/** How the runs that tried to learn fared, over the runs the analytics' `from`, `to` and `agent` pick (by when they
 *  started, unarchived): `runs` with a learning block, `merged`, `dropped` by reason, and `in_progress` (seeded,
 *  reflecting or proposed: a run this server holds). A run with learning off, a workflow's or an imported one, has
 *  none, and is not counted. */
export function learningStats(rows: readonly RunRow[], filter: AnalyticsFilter, learningOf: (row: RunRow) => { state: string; reason: string | null } | null) {
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  const out = { runs: 0, merged: 0, dropped: {} as Record<string, number>, in_progress: 0 };
  for (const row of rows) {
    const at = Date.parse(row.startedAt);
    if (row.kind !== "agentic" || row.importedFrom || row.archivedAt || !(at >= from && at < to) || (filter.agent !== undefined && row.agent !== filter.agent)) continue;
    const learning = learningOf(row);
    if (!learning) continue;
    out.runs += 1;
    if (learning.state === "merged") out.merged += 1;
    else if (learning.state === "dropped") out.dropped[learning.reason ?? "unknown"] = (out.dropped[learning.reason ?? "unknown"] ?? 0) + 1;
    else out.in_progress += 1;
  }
  return out;
}

/** One side of an agent's impact: how many runs, their median time to the answer, the median of their job's own cost
 *  over the `cost_runs` whose cost is known, and the median of what learning itself cost a run (its look-back and its
 *  grade), over the runs that learn whose learning cost is known. */
export type ImpactSide = { runs: number; median_duration_s: number; median_cost_usd: number | null; cost_runs: number; median_learning_usd: number | null };
export type Impact = { before: ImpactSide; after: ImpactSide } | null;
/** What a run's learning tells its impact (learning-run.ts ofAgent), from memory or from its ledger line: how it
 *  ended and when, how many notes it started from, when its answer was final and its costs; `grade_usd` once it ended
 *  (0 when nothing was graded), and `look_back_usd` 0 for a run that never looked back. */
export type ImpactLearning = { state: string; reason: string | null; at: string; seed_notes?: number; answered_at?: string; job_cost_usd?: number | null; look_back_usd?: number | null; grade_usd?: number | null };
/** A completed run as its impact counts it: from its start to its answer, its job's own cost, and what its learning
 *  cost (undefined for a run with learning off; null when unknown). */
type Figures = { seconds: number; cost: number | null; learning?: number | null };
/** The middle of `values` (the mean of the two middle ones when there is an even count); undefined for none. */
const median = (values: readonly number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const usd = (value: number | undefined) => (value === undefined ? null : Math.round(value * 1e6) / 1e6);
const sideOf = (runs: readonly Figures[]): ImpactSide => {
  const costs = runs.flatMap((run) => (run.cost === null ? [] : [run.cost]));
  return {
    runs: runs.length,
    median_duration_s: Math.round(median(runs.map((run) => run.seconds))! * 10) / 10,
    median_cost_usd: usd(median(costs)),
    cost_runs: costs.length,
    median_learning_usd: usd(median(runs.flatMap((run) => (typeof run.learning === "number" ? [run.learning] : [])))),
  };
};
/** Completed run `row` as its impact counts it, `learning` what its learning says. One that looked back answered when
 *  its job ended, and its job's cost is what it had cost by then; any other's are its row's end and cost, which no look
 *  back follows. Undefined for one whose learning a server before these figures kept (it says neither how many notes
 *  it started from nor when it answered): its row's end and cost hold its look-back too. */
function figuresOf(row: RunRow, learning: ImpactLearning | null | undefined): Figures | undefined {
  if (learning && learning.seed_notes === undefined && learning.reason !== "seed_failed") return undefined;
  const looked = learning?.answered_at !== undefined;
  const answered = looked ? Date.parse(learning!.answered_at!) : Date.parse(row.endedAt!);
  const cost = looked ? (learning!.job_cost_usd ?? null) : (row.costUsd ?? null);
  if (!learning) return { seconds: (answered - Date.parse(row.startedAt)) / 1000, cost };
  const { look_back_usd: back, grade_usd: grade } = learning;
  return { seconds: (answered - Date.parse(row.startedAt)) / 1000, cost, learning: typeof back === "number" && typeof grade === "number" ? back + grade : null };
}
/** What learning changed for an agent, from its run rows (`rows`) and what its runs' learning says (`learningOf`),
 *  never a run's files. `after`: its completed agentic runs that started from at least one active note. `before`: its
 *  completed agentic runs that started before its first note, the earlier of its first merge's end and the start of its
 *  first run that started from a note (a person's note comes first that way); none of them could have. Each side's
 *  figures (sideOf, figuresOf): its time to the answer in seconds to a tenth, its job's own cost, what learning cost.
 *  An imported or archived run is on neither side, nor is a later one with learning off or seeded with no note (every
 *  note retired), nor one whose learning predates these figures. Null unless both sides hold 2 runs or more. */
export function learningImpact(rows: readonly RunRow[], learningOf: (row: RunRow) => ImpactLearning | null | undefined): Impact {
  const done = rows.filter((row) => row.kind === "agentic" && !row.importedFrom && !row.archivedAt && row.state === "completed" && row.endedAt);
  const after = done.filter((row) => (learningOf(row)?.seed_notes ?? 0) > 0);
  const merges = rows.flatMap((row) => {
    const learning = learningOf(row);
    return learning?.state === "merged" ? [Date.parse(learning.at)] : [];
  });
  const first = Math.min(...merges, ...after.map((row) => Date.parse(row.startedAt)));
  const counted = (side: readonly RunRow[]) => side.flatMap((row) => figuresOf(row, learningOf(row)) ?? []);
  const [before, later] = [counted(done.filter((row) => Date.parse(row.startedAt) < first)), counted(after)];
  return before.length >= 2 && later.length >= 2 ? { before: sideOf(before), after: sideOf(later) } : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const warn = (runId: string, text: string) => void process.stderr.write(`agentrun-serve: run ${runId}: ${text}\n`);
/** A row of the run's that a person sees. Its rows never hold the reducer's quiet ones (runs.ts take). */
const shows = (row: TimelineEvent) => row.kind !== "usage" && row.kind !== "phase";
/** `work` for `key`, one at a time: the one in flight, else a new one, forgotten once it settles. */
function once(running: Map<string, Promise<void>>, key: string, work: () => Promise<void>): Promise<void> {
  let current = running.get(key);
  if (!current) running.set(key, (current = work().finally(() => running.delete(key))));
  return current;
}

/** What learning needs of the server's options: the data directory and the agents, its tokens, the switch, and its bounds. */
export type LearningOptions = Pick<RunsOptions, "agents" | "token" | "doorToken" | "storedKeys" | "learning" | "reflectTimeoutMs" | "gradeTimeoutMs">;
/** What the kernel (runs.ts) hands learning: its runs, and the parts of a run's life learning moves. */
export type LearningKernel = {
  /** Run `id` when the kernel holds it; read from the agent store the first time (`get`). */
  held(id: string): Run | undefined;
  get(id: string): Promise<Run | null>;
  /** Whether the run's process lives. */
  live(run: Run): boolean;
  /** One request to a live run's door, never waking it, with who sent a turn it sends; one to its door, waking it. */
  toLiveDoor(run: Run, path: string, body?: Json, turnOrigin?: TurnOrigin): Promise<Json | null>;
  toDoor(run: Run, path: string, body: Json): Promise<unknown>;
  /** The run's turn aborted; its process let go (SIGTERM). */
  abortTurn(run: Run): Promise<void>;
  terminate(run: Run): void;
  /** Its status as one more change; its rows, as served, again. */
  mark(run: Run): void;
  show(run: Run): void;
  /** Its serve.json written, in turn (onSaved follows). */
  save(run: Run): Promise<void>;
  /** A run's cost from its rows: null when unknown. */
  costOf(rows: readonly TimelineEvent[]): number | null;
  /** The test hooks startServe's options name, as a run's process gets them. */
  fauxEnv(): NodeJS.ProcessEnv;
};

/** The learning of every run the kernel holds, from the end-of-run turn to the merge. */
export class LearningRuns {
  /** Why this host keeps no learning folder, said once. */
  private learningOff?: string;
  /** The secrets each launch of a run that learns handed its process (runs.ts launch()), by run id, so a key a person
   *  replaced or deleted while the run lived is still refused in what its end-of-run turn wrote. In memory only, never on
   *  disk: a server that restarts loses them, and the run's next launch hands it the keys as they are then, which the
   *  check reads too. Dropped once the run's learning ends, and when the server closes. */
  private readonly handed = new Map<string, Set<string>>();
  /** Aborted as the server closes: a grade's screen and grader stop, and leave the run's learning `proposed`. */
  private readonly stopping = new AbortController();
  /** The runs whose learning's end is in the learning ledger (usage.ts): read at the start, and each one written since. */
  private readonly recorded = new Set<string>();
  /** By run: what its end-of-run turn wrote, being checked (proposeOnce), and its proposal, being graded (gradeOnce). */
  private readonly proposing = new Map<string, Promise<void>>();
  private readonly grading = new Map<string, Promise<void>>();
  /** The host's secrets as shown() last cut them, by their values, and the saved keys it read. */
  private cut?: { key: string; shown: Shown };
  private saved?: Map<string, string | undefined>;
  constructor(private readonly options: LearningOptions, private readonly kernel: LearningKernel) {}

  private get closing(): boolean {
    return this.stopping.signal.aborted;
  }

  // ---- the kernel's calls ---------------------------------------------------------------------------------------------

  /** A run of `revision` about to be made for agent `agentId`. It learns when the server's switch (`--learning`) is on and
   *  its agent's definition says `learning: true`; then its seed is read now, before the run is made, so the folder is
   *  read once whatever the run's setup does, and what comes back pins it in the run once it is made and its input
   *  saved (a server that goes down during the copy leaves no learning saved: onLoad), at `at`: its
   *  learning, `seeded`, or `dropped` as `seed_failed` (a learning fault never refuses a run). Undefined when it does
   *  not learn. */
  async onStart(agentId: string, revision: Revision): Promise<((started: Pick<StartedRun, "runId" | "dir" | "workspace">, at: string) => Promise<Learning>) | undefined> {
    const learns = this.options.learning !== "off" && revision.kind === "agentic" && revision.body.learning === true;
    if (!learns) return undefined;
    const seeded = await this.seedFor(agentId);
    return async (started, at) => {
      let failed = "failed" in seeded ? seeded.failed : undefined;
      if ("seed" in seeded) {
        try {
          await pinSeed(started.dir, started.workspace, seeded.seed);
          for (const path of seeded.seed.skipped) warn(started.runId, `its learning folder's ${path} was not read`);
        } catch (error) {
          warn(started.runId, `starts with nothing learned: ${(error as Error).message}`);
          failed = said.stopped(STOPPED.notCopied);
        }
      }
      const notes = "seed" in seeded ? Object.keys(seeded.seed.notes).length : 0;
      return failed === undefined ? { state: "seeded", reason: null, detail: said.seeded(notes), at, seed_notes: notes } : { state: "dropped", reason: "seed_failed", detail: failed, at };
    };
  }

  /** The run's serve.json holds `learning` now: the learning ledger's line for the run (usage.ts), once, when that
   *  learning has ended. Never rejects: a line not written is written by the next save, or by the next start's pass. */
  onSaved(run: Pick<Run, "id" | "agentId">, learning: Learning | null | undefined): Promise<void> {
    if (ended(learning)) this.handed.delete(run.id);
    if (!ended(learning) || this.recorded.has(run.id)) return Promise.resolve();
    this.recorded.add(run.id);
    return record(this.options.agents.dir, outcomeOf(run.id, run.agentId, learning)).catch((error: Error) => {
      this.recorded.delete(run.id);
      warn(run.id, `its learning's end is not in the ledger yet: ${error.message}`);
    });
  }

  /** The run's job ended with `end`. True when its end-of-run turn is asked first: the run is finishing with that
   *  outcome, and is let go once the turn ends. False when it is let go now, its learning dropped when it skips the turn. */
  beforeFinish(run: Run, end: { outcome: Status; error?: Run["error"]; abort?: boolean }): boolean {
    const skip = this.reflectSkip(run, end);
    if (skip === undefined) {
      this.reflect(run, end.outcome);
      return true;
    }
    if (skip) this.dropLearning(run, ...skip);
    return false;
  }

  /** A run read at a start, before the kernel holds it, `save` writing its serve.json: one a server went down while it
   *  copied the run's seed (running, its input saved and no learning, and a pin or a `work/.learning/` there) has both
   *  taken back, so it starts again with nothing learned, and its learning dropped as `seed_failed`, saved before the
   *  ledger's line (onSaved). Called before anything reads the run: its relaunch, a settle, a follow-up. A seed_failed
   *  run asks no end-of-run turn (reflectSkip). A copy that never began leaves nothing, and the learning stays null. */
  async onLoad(row: Pick<RunRow, "id" | "agent" | "state">, dir: string, meta: Run["meta"], save: () => Promise<void>): Promise<void> {
    if (row.state !== "running" || meta.learning || !(await dropSeed(dir, join(dir, "work")))) return;
    meta.learning = { state: "dropped", reason: "seed_failed", detail: said.stopped(STOPPED.serverStopped), at: new Date().toISOString() };
    await save();
    warn(row.id, "its server stopped while it copied what its agent learned; it starts again with nothing learned");
    await this.onSaved({ id: row.id, agentId: row.agent }, meta.learning);
  }

  /** A run's process launched, handed the secrets named `names`: what each held then, as handover read it, kept beside
   *  the run while its learning is under way (a key replaced since stays refused in its notes). */
  onLaunch(run: Run, names: readonly string[]): void {
    if (!run.meta.learning || ended(run.meta.learning)) return;
    const values = names.flatMap((name) => secret(name, this.options.storedKeys) ?? []);
    if (!values.length) return;
    const kept = this.handed.get(run.id) ?? new Set<string>();
    for (const value of values) kept.add(value);
    this.handed.set(run.id, kept);
  }

  /** A running run read at a start, `live` when its process serves it still. One a server left while its end-of-run turn
   *  ran is finishing with its job's outcome, and nothing opens it again; when its process lives, the turn is asked again
   *  under the same request id, which it takes once, and waited for. */
  onAdopt(run: Run, live: boolean): void {
    if (!reflecting(run)) return;
    run.finishing = run.meta.reflect!.outcome;
    if (run.meta.error) run.error = { ...run.meta.error, retryable: false };
    if (live) void this.reflectTurn(run);
  }

  /** The run's end being written: its end-of-run turn's rows closed, and its learning settled from how the turn went;
   *  then what the turn wrote set aside before the run reads ended, so a follow-up that opens it again never changes
   *  what is checked. */
  async beforeSettle(run: Run, outcome: Status): Promise<void> {
    this.closeLearning(run, outcome);
    if (awaitsPropose(run.meta)) {
      await snapshotLearned(run.dir).catch((error: Error) => {
        warn(run.id, `what its end-of-run turn wrote could not be set aside: ${error.message}`);
        this.setLearning(run, "dropped", "propose_failed", said.stopped(STOPPED.notSetAside));
      });
    }
    await this.noteUsed(run);
  }

  /** The run's end written, as it would be without learning: what its end-of-run turn wrote checked, then graded and
   *  merged. Called only then, so a slow or failing check never holds the job. A run already `proposed` is graded: one
   *  a follow-up opened again mid-grade, whose server went while it ran, which the next start passed over as running.
   *  gradeOnce does nothing for any other state, nor while a grade of the run is in flight here. */
  afterSettle(run: Run): Promise<void> {
    const proposing = this.proposeOnce(run);
    void this.gradeOnce(run);
    return proposing;
  }

  /** A run that learns, opened again for a follow-up once its end-of-run turn's copy went to its snapshot, before its
   *  process starts: `work/.learning/` laid again from its seed, so the follow-up finds the notes its instructions name
   *  where they say. A fault leaves it without. */
  async onReopen(run: Run): Promise<void> {
    const dir = join(run.dir, "work", LEARNED_DIR);
    if (!run.meta.reflect || (await lstat(dir).then(() => true, () => false))) return;
    try {
      const pin = await readPin(run.dir);
      if (pin) await layLearned(dir, await seedAt(this.options.agents.dir, run.agentId, pin.seed));
    } catch (error) {
      warn(run.id, `opens again without its copy of what its agent learned: ${(error as Error).message}`);
    }
  }

  /** Its process launched again for the follow-up: an end-of-run turn its process went in would resume with the run, so
   *  it is aborted before the follow-up is sent. One that cannot be aborted runs out ahead of it, and its rows are never
   *  the follow-up's answer, which comes after them. */
  async afterReopen(run: Run): Promise<void> {
    if (run.meta.reflect && run.meta.learning?.reason === "crashed") await this.kernel.toDoor(run, "/abort", {}).catch(() => undefined);
  }

  /** The server's start: the learning ledger read from now, beside the running runs' pass, never before it (a line
   *  written twice meanwhile is read once). What comes back takes every run once that pass is done: each ended run whose
   *  learning a server left between steps, what its end-of-run turn wrote not checked yet, or its proposal not graded or
   *  merged, is checked or graded now, once; a learning end saved and not in the ledger (a server that went between the
   *  two) is written there. */
  recover(): (rows: readonly RunRow[]) => Promise<void> {
    const inLedger = outcomes(this.options.agents.dir).catch(() => new Map<string, unknown>());
    return async (rows) => {
      for (const run of (await inLedger).keys()) this.recorded.add(run);
      for (const row of rows) {
        if (this.closing) return;
        if (row.state === "running" || row.importedFrom || row.kind !== "agentic") continue;
        const meta = (await readJson(join(this.options.agents.dir, "runs", row.id, RUN_META))) as Partial<Run["meta"]> | null;
        const learning = isObject(meta?.learning) ? meta.learning : undefined;
        await this.onSaved({ id: row.id, agentId: row.agent }, learning);
        if (!awaitsPropose(meta) && learning?.state !== "proposed") continue;
        const run = await this.kernel.get(row.id).catch((error: Error) => (warn(row.id, `not read: ${error.message}; the next start tries again`), null));
        if (run && awaitsPropose(run.meta)) await this.proposeOnce(run);
        else if (run) void this.gradeOnce(run);
      }
    };
  }

  /** The server closing: a grade's screen and grader stop, and leave the run's learning `proposed`; nothing new starts. */
  close(): void {
    this.stopping.abort();
    this.handed.clear();
  }

  /** Once every run has settled: each check in flight, then each grade, ended. */
  async idle(): Promise<void> {
    await Promise.all(this.proposing.values());
    await Promise.all(this.grading.values());
  }

  /** A held run's learning, in short, from memory (null when it does not learn); undefined for a run the kernel does not
   *  hold. For a count, which reads the rest from the learning ledger and never a run's files. */
  heldLearning(runId: string): { state: LearningState; reason: LearningReason | null } | null | undefined {
    const held = this.kernel.held(runId);
    if (!held) return undefined;
    const learning = held.meta.learning;
    return learning ? { state: learning.state, reason: learning.reason } : null;
  }

  /** The host's secrets as they are now, as a reader cuts them (secretsShown): the ones this server holds, the keys
   *  saved on it, and its tokens, as the learning routes cut them. Built again only once they change. Every run's view
   *  and every row of a list asks it, so the saved keys, which are read from their file and opened one by one, are read
   *  once and kept until a person saves or deletes one (keysChanged). */
  shown(): Shown {
    const saved = (this.saved ??= new Map(SECRET_NAMES.map((name) => [name, this.options.storedKeys?.(name)])));
    const values = [...hostSecrets(process.env, (name) => saved.get(name)), this.options.token, this.options.doorToken];
    const key = values.join("\0");
    if (this.cut?.key !== key) this.cut = { key, shown: secretsShown(values) };
    return this.cut.shown;
  }

  /** A key was saved on this server or deleted from it: the next view reads them again. */
  keysChanged(): void {
    this.saved = undefined;
  }

  /** A run's learning as its view shows it (learning.ts learningView), cut of the host's secrets now; `settled`, once
   *  the run has ended and settled, shows the notes it read. */
  view(learning: Learning | undefined, settled: boolean) {
    return learning ? learningView(learning, this.shown(), settled) : null;
  }

  /** A run's learning as a list shows it (learning.ts shortLearning): from serve.json for a run the kernel does not hold. */
  short(learning: Learning | null, settled: boolean) {
    return shortLearning(learning, this.shown(), settled);
  }

  /** How the runs `rows` holds that tried to learn fared, over `filter` (learningStats): a held run's learning from
   *  memory, any other's end from the learning ledger, never a run's files. */
  async counts(rows: readonly RunRow[], filter: AnalyticsFilter): Promise<ReturnType<typeof learningStats>> {
    const ledger = await outcomes(this.options.agents.dir);
    return learningStats(rows, filter, (row) => this.heldLearning(row.id) ?? ledger.get(row.id) ?? null);
  }

  /** Agent `agentId`'s runs (`rows`, its own) as its learning view counts them, the ledger read once: how they fared
   *  (counts, less `runs`), and what learning changed (learningImpact), each run's learning from memory when the kernel
   *  holds it, else its end from its ledger line; never a run's files. */
  async ofAgent(rows: readonly RunRow[], agentId: string): Promise<{ counts: Omit<ReturnType<typeof learningStats>, "runs">; impact: Impact }> {
    const ledger = await outcomes(this.options.agents.dir);
    const learningOf = (row: RunRow): ImpactLearning | null => {
      const held = this.kernel.held(row.id);
      if (!held) {
        const line = ledger.get(row.id);
        return line ? { ...line, grade_usd: line.cost } : null;
      }
      const learning = held.meta.learning;
      if (!learning) return null;
      // As its ledger line will say it (usage.ts outcomeOf): its grade's cost and its look-back's once it ended.
      const over = ended(learning);
      const { look_back_usd, ...rest } = learning;
      return { ...rest, ...(over ? { grade_usd: learning.cost_usd ? learning.cost_usd.grade : 0 } : {}), ...(learning.answered_at !== undefined ? { look_back_usd } : over ? { look_back_usd: 0 } : {}) };
    };
    const { runs: _, ...counts } = learningStats(rows, { agent: agentId }, learningOf);
    return { counts, impact: learningImpact(rows, learningOf) };
  }

  // ---- the run's learning ---------------------------------------------------------------------------------------------

  /** What a run of `agentId` starts from: its learning folder's main (learning.ts), the folder made first when it is
   *  absent; else why it starts with nothing learned. A learning fault never refuses a run: a host without the git
   *  learning needs is said once, and a folder that cannot be made or read once per run. */
  private async seedFor(agentId: string): Promise<{ seed: Seed } | { failed: string }> {
    const blocked = await learningBlocker(process.env);
    if (blocked) {
      if (this.learningOff !== blocked) process.stderr.write(`agentrun-serve: runs start with nothing learned: ${blocked}\n`);
      this.learningOff = blocked;
      return { failed: said.stopped(STOPPED.noGit) };
    }
    return seedOf(this.options.agents.dir, agentId).then((seed) => ({ seed }), (error: Error) => {
      process.stderr.write(`agentrun-serve: the agent ${agentId}'s learning folder could not be read, so its run starts with nothing learned: ${error.message}\n`);
      return { failed: said.stopped(STOPPED.unreadable) };
    });
  }

  /** Moves the run's learning on, and shows its row. What it keeps whatever it does after (learning.ts KEPT_LEARNING:
   *  the notes the run read, how many it started from, its answer's time and costs) stays with it. Saved by the caller,
   *  or with the run's end. */
  private setLearning(run: Run, state: LearningState, reason: LearningReason | null = null, detail: string | null = null, more: Omit<Partial<Learning>, "state" | "reason" | "detail" | "at"> = {}): void {
    const before = run.meta.learning;
    const kept = Object.fromEntries(KEPT_LEARNING.flatMap((key) => (before?.[key] === undefined ? [] : [[key, before[key]]])));
    run.meta.learning = { state, reason, detail, at: new Date().toISOString(), ...kept, ...more };
    run.updatedAt = run.meta.learning.at;
    this.kernel.show(run);
  }

  /** As the run settles, before its end is written: the notes its job read from its copy of the folder (notesRead), by
   *  their names in its seed, kept with its learning (`used`), so a view or a list reads them from serve.json and never
   *  from its rows again. Only a note the run started from counts: MEMORY.md, a file the run wrote there, and a note
   *  not in its seed are not notes it used. Read again at each settle, a follow-up's reads with the rest. A seed that
   *  cannot be read leaves what was there, and says why. */
  private async noteUsed(run: Run): Promise<void> {
    if (!run.meta.learning) return;
    const files = notesRead(run.meta.reflect, run.rows);
    let used: NonNullable<Learning["used"]> = [];
    if (files.length) {
      try {
        const pin = await readPin(run.dir);
        const names = new Map(pin ? activeOf(await seedAt(this.options.agents.dir, run.agentId, pin.seed)).map((note) => [note.file, note.name]) : []);
        used = files.flatMap((file) => (names.has(file) ? [{ file, name: names.get(file)! }] : []));
      } catch (error) {
        return warn(run.id, `which notes it read is not known: ${(error as Error).message}`);
      }
    }
    // As the learning is now: nothing else changed it meanwhile, but its object may be a new one.
    const learning = run.meta.learning;
    if (!learning) return;
    const { used: _, ...rest } = learning;
    run.meta.learning = used.length ? { ...rest, used } : rest;
  }

  private dropLearning(run: Run, reason: LearningReason, detail: string): void {
    this.setLearning(run, "dropped", reason, detail);
    void this.kernel.save(run).catch((error: Error) => warn(run.id, `its learning's drop is not saved: ${error.message}`));
  }

  /** Why a run that just ended asks no end-of-run turn: a drop's reason and detail; null when it does not learn, or asked
   *  one already (one per run, ever); undefined when it asks one. The cap keeps no reserve: a run its cap stopped has no
   *  room left, and one whose spend is unknown cannot be kept within its cap. */
  private reflectSkip(run: Run, end: { outcome: Status; error?: Run["error"]; abort?: boolean }): [LearningReason, string] | null | undefined {
    if (run.meta.learning?.state !== "seeded" || run.meta.reflect) return null;
    if (run.cancel) return ["cancelled", said.stopped(STOPPED.cancelled)];
    if (end.abort || end.error?.code === SPEND_CAP_REACHED) return ["no_budget", said.noBudget];
    if (run.meta.max_cost_usd !== undefined && this.kernel.costOf(run.rows) === null) return ["unknown_cost", said.unknownCost];
    if (!run.writes) return ["no_write_tool", said.noWriteTool];
    return undefined;
  }

  /** The run answered or failed: it is finishing with that outcome, and its harness is asked one end-of-run turn first.
   *  The turn is saved before it is asked, so a restart asks it again under the same id, never twice. */
  private reflect(run: Run, outcome: Status): void {
    run.finishing = outcome;
    run.endedAt = new Date().toISOString();
    const after = run.lastEntry ?? Math.max(0, ...run.rows.map((row) => entryOf(row.id)).filter(Number.isInteger));
    run.meta.reflect = { outcome, after, deadline: new Date(Date.now() + (this.options.reflectTimeoutMs ?? REFLECT_TIMEOUT_MS)).toISOString() };
    // The job's error, kept for a restart: the turn's is never the run's.
    if (run.error) run.meta.error = { code: run.error.code, message: run.error.message, ...(run.error.details ? { details: run.error.details } : {}) };
    // Its answer is final now: when, and what its job cost, before the end-of-run turn spends any more.
    this.setLearning(run, "reflecting", null, said.reflecting, { answered_at: run.endedAt, job_cost_usd: this.kernel.costOf(run.rows) });
    this.kernel.mark(run);
    void this.reflectTurn(run);
  }

  /** Lays the run's copy of its agent's folder again from its seed (once: a restart that asks again keeps what the turn
   *  wrote), asks the end-of-run turn through the run's door and waits for its end, its deadline (the turn is aborted)
   *  or the process to go; then lets the run go. */
  private async reflectTurn(run: Run): Promise<void> {
    const reflect = run.meta.reflect!;
    const dir = join(run.dir, "work", LEARNED_DIR);
    let end: "ended" | "timeout" | "gone" = "gone";
    try {
      const pin = await readPin(run.dir);
      if (!pin) throw new Error("the run has no learning pin");
      const seed = await seedAt(this.options.agents.dir, run.agentId, pin.seed);
      // What the job's own turns left in the copy is not the end-of-run turn's to propose.
      if (!reflect.laid) {
        await layLearned(dir, seed);
        reflect.laid = true;
      }
      await this.kernel.save(run);
      const { reflectPrompt } = await import("./learn/index.js");
      // The one call that sends the end-of-run turn, with its origin.
      await this.kernel.toLiveDoor(run, "/submit", { requestId: reflectId(run.id), content: reflectPrompt({ dir: LEARNED_DIR, active: Object.keys(seed.notes).length }), whenBusy: "followUp" }, REFLECT_ORIGIN);
      end = await this.reflectEnd(run, Date.parse(reflect.deadline));
    } catch (error) {
      if (!this.kernel.live(run) || run.cancel) return;
      warn(run.id, `its end-of-run turn was not asked: ${(error as Error).message}`);
      this.dropLearning(run, "reflect_failed", said.stopped(STOPPED.notAsked));
      return this.kernel.terminate(run);
    }
    if (end === "gone") return;
    if (end === "ended") reflect.ended = true;
    else {
      reflect.timedOut = true;
      await this.kernel.abortTurn(run);
    }
    await this.kernel.save(run).catch((error: Error) => warn(run.id, `its end-of-run turn's end is not saved: ${error.message}`));
    this.kernel.terminate(run);
  }

  /** How the end-of-run turn ends: `ended` once the run's door says it is idle (the turn was taken before the submit was
   *  answered, so idle is after it), `timeout` at `deadline`, `gone` when the process went or the run was cancelled. */
  private async reflectEnd(run: Run, deadline: number): Promise<"ended" | "timeout" | "gone"> {
    for (;;) {
      const status = await this.kernel.toLiveDoor(run, "/status").catch(() => null);
      if (!this.kernel.live(run) || run.cancel) return "gone";
      if (isObject(status?.busy) && status.busy.kind === "idle") return "ended";
      if (Date.now() >= deadline) return "timeout";
      await sleep(REFLECT_POLL_MS);
    }
  }

  /** At the run's end: the end-of-run turn's rows closed, and its learning settled from how the turn went. A run that
   *  never left `seeded` went before it could reflect. */
  private closeLearning(run: Run, outcome: Status): void {
    const { learning, reflect } = run.meta;
    if (learning?.state === "seeded") return this.setLearning(run, "dropped", ...((run.cancel || outcome === "cancelled" ? ["cancelled", said.stopped(STOPPED.cancelled)] : ["crashed", said.stopped(STOPPED.crashed)]) as [LearningReason, string]));
    if (!reflect || reflect.until !== undefined) return;
    reflect.until = run.lastEntry ?? reflect.after;
    // The run ends now, when its end-of-run turn closed: `answered_at` keeps when its job answered, and the end the run's
    // settle writes once (runs.ts carryBack) is this one, not the answer's.
    run.endedAt = new Date().toISOString();
    // What the turn cost: the run's cost now, its job's set apart; unknown when either is.
    if (learning) {
      const total = this.kernel.costOf(run.rows);
      const job = learning.job_cost_usd;
      run.meta.learning = { ...learning, look_back_usd: total === null || job === null || job === undefined ? null : Math.max(0, Math.round((total - job) * 1e9) / 1e9) };
    }
    if (learning?.state !== "reflecting") return;
    const last = run.rows.findLast((row) => row.agent_label === LEARNING_LABEL && shows(row));
    if (run.cancel) this.setLearning(run, "dropped", "cancelled", said.stopped(STOPPED.cancelledLooking));
    else if (reflect.timedOut) this.setLearning(run, "dropped", "reflect_timeout", said.stopped(STOPPED.timedOut));
    else if (last?.kind === "error" && CAP_REFUSAL_PREFIX.test(last.text ?? "")) this.setLearning(run, "dropped", "no_budget", said.noBudget);
    else if (last?.kind === "error") this.setLearning(run, "dropped", "reflect_failed", said.stopped(STOPPED.failed));
    else if (!reflect.ended) this.setLearning(run, "dropped", "crashed", said.stopped(STOPPED.crashedLooking));
    else this.setLearning(run, "reflecting", null, said.reflecting);
  }

  /** What the run's end-of-run turn wrote, checked and kept as its proposal or dropped (propose.ts), once at a time, after
   *  the run has ended. Never rejects: `proposed` or `dropped`, `propose_failed` for a fault. A server that goes
   *  meanwhile leaves it `reflecting` in serve.json, and the next start checks it again. */
  private proposeOnce(run: Run): Promise<void> {
    if (!awaitsPropose(run.meta)) return Promise.resolve();
    return once(this.proposing, run.id, () => this.propose(run));
  }

  private async propose(run: Run): Promise<void> {
    try {
      await learningTestHooks.beforePropose?.(run.dir);
      const pin = await readPin(run.dir);
      if (!pin) throw new Error("the run has no learning pin");
      const { proposeRun } = await import("./propose.js");
      // The secrets this server holds, wherever its launcher put them, the keys saved on it, what each launch handed the
      // run, and its own tokens.
      const proposed = await proposeRun({ data: this.options.agents.dir, agentId: run.agentId, runDir: run.dir, seed: pin.seed, refuse: this.refused(run) });
      if (proposed.state === "proposed") this.setLearning(run, "proposed", null, said.proposed(proposed.notes));
      else if (proposed.reason === "empty") this.setLearning(run, "dropped", "empty", said.empty);
      else this.setLearning(run, "dropped", "checker", said.checker(proposed.problems), { problems: proposed.problems });
    } catch (error) {
      warn(run.id, `what its end-of-run turn wrote could not be checked: ${(error as Error).message}`);
      this.setLearning(run, "dropped", "propose_failed", said.stopped(STOPPED.notChecked));
    }
    await this.kernel.save(run).catch((error: Error) => warn(run.id, `its learning is not saved: ${error.message}`));
    void this.gradeOnce(run);
  }

  /** The run's proposal merged into main or dropped (grade.ts), one grade at a time per agent, after the checks and
   *  never in a run's way. The verdict and what the grade spent are kept in serve.json before the merge, so a restart
   *  never asks the grader again; what it spent is in the ledger with the run's end. A server that closes mid-grade leaves the
   *  learning `proposed`, and its next start grades it. */
  private gradeOnce(run: Run): Promise<void> {
    if (run.meta.learning?.state !== "proposed") return Promise.resolve();
    return once(this.grading, run.id, () => withAgentGrade(this.options.agents.dir, run.agentId, () => this.grade(run)));
  }

  private async grade(run: Run): Promise<void> {
    const before = run.meta.learning;
    if (before?.state !== "proposed" || this.closing) return;
    const data = this.options.agents.dir;
    let kept: Omit<Partial<Learning>, "state" | "reason" | "detail" | "at"> = before.verdict ? { verdict: before.verdict, graded: before.graded, cost_usd: before.cost_usd, tokens: before.tokens } : {};
    // Its end saved, and with it its line in the ledger, which carries what the grade spent (onSaved).
    const end = (state: LearningState, reason: LearningReason | null, detail: string, more: typeof kept = {}) => {
      this.setLearning(run, state, reason, detail, { ...kept, ...more });
      return this.kernel.save(run).catch((error: Error) => warn(run.id, `its learning is not saved: ${error.message}`));
    };
    try {
      const proposal = JSON.parse(await readFile(join(run.dir, PROPOSAL), "utf8")) as Proposal;
      const known = await this.options.agents.revision(run.agentId, run.revision);
      if (known?.revision.kind !== "agentic") throw new Error("the run's revision is not agentic");
      const { judgeProposal, mergeProposal, readForGrade } = await import("./grade.js");
      const main = kept.verdict ? undefined : await readForGrade(data, run.agentId, run.id, proposal);
      // Main took a note of the same name, or superseded one it supersedes, since the run started: refused before the
      // grader is asked.
      if (main && "problems" in main) return await end("dropped", "checker", said.stale(main.problems), { problems: main.problems });
      if (main && !("merged" in main)) {
        const { instructions, harness, model, thinking } = known.revision.body;
        const judged = await judgeProposal({ runId: run.id, agent: { instructions, harness, model, thinking }, main, proposed: proposal.notes, env: this.hostEnv(), signal: this.stopping.signal, ...(this.options.gradeTimeoutMs ? { gradeTimeoutMs: this.options.gradeTimeoutMs } : {}) });
        kept = { cost_usd: { grade: judged.cost.usd }, tokens: { grade: judged.cost.tokens } };
        if ("file" in judged) return await end("dropped", judged.reason, judged.reason === "screen" ? said.screen : said.stopped(STOPPED.screenDown));
        if ("error" in judged) {
          warn(run.id, `its grader gave no verdict: ${judged.error.message}`);
          return await end("dropped", "grade_failed", said.stopped(STOPPED.noReview));
        }
        // Kept cut of every secret the run's notes were checked against, the keys its launches handed it included, which a
        // read no longer knows: its reason and its items' words are what the run's words are said from again (wordsOf).
        kept.verdict = cutVerdict(judged.verdict, this.refused(run));
        if (!kept.verdict.merge) return await end("dropped", "grader", notKept(kept.verdict));
        // Kept before the merge, with the blobs it judged superseded: a restart merges on this verdict, never asks the
        // grader again, and checks the same blobs.
        kept.graded = main.graded;
        this.setLearning(run, "proposed", null, before.detail, kept);
        await this.kernel.save(run);
      }
      // A verdict kept with no `graded`: a note the proposal supersedes is refused, never marked on a text nobody knows
      // was read.
      const merge = await mergeProposal(data, run.agentId, run.id, proposal, kept.verdict?.reason || "The grader kept every new note.", kept.graded ?? {});
      if ("problems" in merge) return await end("dropped", "checker", said.stale(merge.problems), { problems: merge.problems });
      if (merge.checkout) warn(run.id, `its merge is on main, but the folder's files were not brought in line: ${merge.checkout.message}`);
      const learned = learnedOf(proposal);
      await end("merged", null, redactSecrets(said.merged(learned), this.refused(run)), { merged: merge.merged, learned });
    } catch (error) {
      // A server closing: nothing was decided, and the next start grades the run.
      if (this.closing) return;
      warn(run.id, `what it proposed could not be graded: ${(error as Error).message}`);
      await end("dropped", "grade_failed", said.stopped(STOPPED.notReviewed));
    }
  }

  /** What a run's learning refuses, and cuts from what it says: the secrets this server holds, wherever its launcher put
   *  them, the keys saved on it, what each launch handed the run, and its own tokens. */
  private refused(run: Run): string[] {
    return [...hostSecrets(process.env, this.options.storedKeys), ...(this.handed.get(run.id) ?? []), this.options.token, this.options.doorToken];
  }

  /** This server's environment for a call of its own (a grade's screen and grader): its secrets readable, never a
   *  child's, the keys saved on it with them (a Jev key saved through the settings API screens as one in the environment
   *  does), and the test hooks a run's process gets. */
  private hostEnv(): NodeJS.ProcessEnv {
    return withSecrets({ ...withoutFaux(process.env), ...this.kernel.fauxEnv() }, "all", this.options.storedKeys);
  }
}
