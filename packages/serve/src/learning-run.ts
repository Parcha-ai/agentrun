// A run's learning, the server half that is left: the seed and the view. runs.ts owns a run's process, its door, its
// rows and its serve.json; it builds one LearningRuns and calls it where a run's life meets learning:
//   onStart       the run about to be made: its seed read first, then pinned in it once it is (learning.ts)
//   onSaved       its serve.json written: the learning ledger's line, once its learning ended (usage.ts)
//   onLoad        a run read at a start, before the kernel holds it: a seed copy a server went down during taken back
//   onReopen      a follow-up: its copy laid again where it is gone
//   recover       the server's start: a learning end saved and not in the ledger, written there
//   current, view, short, shown, keysChanged, counts, ofAgent   what the run's view and the learning routes read
// The end-of-run turn, its check, the grade and the merge are the runner's (runner/learning-end.ts, reflect-hook.ts,
// learning-loop.ts); a run's learning itself is in its serve.json (`learning`), which the kernel writes.
import { join, posix } from "node:path";
import { INDEX_FILE } from "./learn/index.js";
import { type AnalyticsFilter, type Revision, runDirIn, type RunRow, type StartedRun } from "@parcha/pi-durable-agent";
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { readJson, RUN_META } from "./files.js";
import { currentLearning, detailShown, dropSeed, holdsForOk, layLearned, layPinnedSkills, LEARNED_DIR, type Learning, LEARNING_BUDGET, type NoteRuns, LEARNING_LABEL, LEARNING_REASONS, learningTestHooks, learningView, pinSeed, readPin, secretsShown, type Seed, seedAt, seedOf, shortLearning, type Shown, skillsAt } from "./learning.js";
import { statusesOf } from "./learning-routes.js";
import { servedOnly } from "./served-only.js";
import type { Run, RunsOptions } from "./runs.js";
import { SECRET_NAMES } from "./secrets.js";
import { said, STOPPED } from "./learning-words.js";
import { ended, lineNotesOf, type NoteFiles, notesLineOf, notesOf, type Outcome, outcomeOf, outcomes, record } from "./usage.js";
import { isObject } from "./validate.js";
import { isWorkspaceError, localWorkspace } from "./workspace/index.js";
import { type Reflect, reflects } from "./reflect-range.js";

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
  // Only the served view makes it (servedOnly): learning that starts over (seeded, reflecting) drops it, even while a
  // live process feeds the timeline.
  return [...rows, servedOnly(row)];
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
    // A reason this server does not give (an older server's) is not counted, held or from the ledger alike.
    if (!learning || (learning.reason !== null && !(LEARNING_REASONS as readonly string[]).includes(learning.reason))) continue;
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
/** Each note's count of runs that were given it and that read it, by its file, over runs' note files (usage.ts
 *  notesOf, lineNotesOf): a held run's from its learning, an ended one's from its ledger line. A run counts a note
 *  once each way. */
export function noteRuns(runs: readonly (NoteFiles | null | undefined)[]): NoteRuns {
  const out: NoteRuns = new Map();
  for (const files of runs) {
    if (!files) continue;
    for (const key of ["given", "read"] as const) {
      for (const file of new Set(files[key])) {
        const counts = out.get(file) ?? { given: 0, read: 0 };
        counts[key] += 1;
        out.set(file, counts);
      }
    }
  }
  return out;
}

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

/** The files a run was given and read (usage.ts notesOf, lineNotesOf), as one key. */
const filesKey = (files: NoteFiles) => JSON.stringify(files);
const warn = (runId: string, text: string) => void process.stderr.write(`agentrun-serve: run ${runId}: ${text}\n`);

/** What learning needs of the server's options: the data directory and the agents, the secrets it never shows, the
 *  switch, and its budget. */
export type LearningOptions = Pick<RunsOptions, "agents" | "storedKeys" | "serverSecrets" | "learning" | "learningBudget">;
/** What the kernel (runs.ts) hands learning: the runs it holds. */
export type LearningKernel = {
  /** Run `id` when the kernel holds it. */
  held(id: string): Run | undefined;
};

/** The learning of every run the kernel holds: its seed and what its view reads. */
export class LearningRuns {
  /** The runs whose learning's end is in the learning ledger (usage.ts), each with the files its lines say it was given
   *  and read (filesKey): read at the start, and each one written since. */
  private readonly recorded = new Map<string, string>();
  /** The host's secrets as shown() last cut them, by their values, and the saved keys it read. */
  private cut?: { key: string; shown: Shown };
  private saved?: Map<string, string | undefined>;
  constructor(private readonly options: LearningOptions, private readonly kernel: LearningKernel) {}

  // ---- the kernel's calls ---------------------------------------------------------------------------------------------

  /** A run of `revision` about to be made for agent `agentId`. It learns when the server's switch (`--learning`) is on and
   *  its agent's definition says `learning: true`; then its seed is read now, before the run is made, so the folder is
   *  read once whatever the run's setup does, and what comes back pins it in the run once it is made and its input
   *  saved (a server that goes down during the copy leaves no learning saved: onLoad), at `at`: its
   *  learning, `seeded`, or `dropped` as `seed_failed` (a learning fault never refuses a run). Undefined when it does
   *  not learn. What the run reads under `# Learned` is its notes within the server's learning budget, told of
   *  `.learning/` only when its agent has the read tool, and cut of the host's secrets as they are then. */
  async onStart(agentId: string, revision: Revision): Promise<((started: Pick<StartedRun, "runId" | "dir" | "workspace">, at: string) => Promise<Learning>) | undefined> {
    const learns = this.options.learning !== "off" && revision.kind === "agentic" && revision.body.learning === true;
    if (!learns) return undefined;
    const read = revision.kind === "agentic" && revision.body.tools.includes("read");
    const seeded = await this.seedFor(agentId);
    return async (started, at) => {
      let failed = "failed" in seeded ? seeded.failed : undefined;
      // The notes its # Learned section names (learning.ts givenOf, as its pin keeps them): what it started with.
      let given: NonNullable<Learning["given"]> = [];
      if ("seed" in seeded) {
        try {
          const own = revision.kind === "agentic" ? Object.keys(revision.body.skills) : [];
          const pin = await pinSeed(started.dir, localWorkspace(started.workspace), seeded.seed, { budget: this.options.learningBudget ?? LEARNING_BUDGET, read, shown: this.shown(), own });
          given = pin.given ?? [];
          for (const path of seeded.seed.skipped) warn(started.runId, `its learning folder's ${path} was not read`);
          for (const line of seeded.warned) warn(started.runId, line);
          for (const name of pin.skills_left_out ?? []) warn(started.runId, `starts without the skill ${name} its agent learned: it is over what is left of the learned skills' budget, or holds a secret`);
          for (const name of pin.workflows_left_out ?? []) warn(started.runId, `starts without the workflow ${name} its agent learned: its line is over what is left of the learned_workflow tool's description budget, or it holds a secret`);
        } catch (error) {
          warn(started.runId, `starts with nothing learned: ${(error as Error).message}`);
          failed = said.stopped(STOPPED.notCopied);
        }
      }
      await learningTestHooks.afterSeed?.(started.dir);
      const notes = "seed" in seeded ? Object.keys(seeded.seed.notes).length : 0;
      return failed === undefined ? { state: "seeded", reason: null, detail: said.seeded(notes), at, seed_notes: notes, ...(given.length ? { given } : {}) } : { state: "dropped", reason: "seed_failed", detail: failed, at };
    };
  }

  /** A start whose seed copy threw out of its pin (runs.ts start): its learning, in its own words, as a copy that failed
   *  says it; the copy taken back. */
  async copyThrew(started: Pick<StartedRun, "runId" | "dir" | "workspace">, at: string, error: unknown): Promise<Learning> {
    warn(started.runId, `starts with nothing learned: ${error instanceof Error ? error.message : String(error)}`);
    await dropSeed(started.dir, localWorkspace(started.workspace)).catch(() => undefined);
    return { state: "dropped", reason: "seed_failed", detail: said.stopped(STOPPED.notCopied), at };
  }

  /** The run's serve.json holds `learning` now: the learning ledger's line for the run (usage.ts), once, when that
   *  learning has ended; after it, a `notes` line each time the notes it was given or read are no longer what the
   *  ledger says (a follow-up read another note), which counts neither the run nor its costs again. Never rejects: a
   *  line not written is written by the next save, or by the next start's pass. */
  onSaved(run: Pick<Run, "id" | "agentId">, learning: Learning | null | undefined): Promise<void> {
    if (!ended(learning)) return Promise.resolve();
    const was = this.recorded.get(run.id);
    const files = filesKey(notesOf(learning));
    if (was === files) return Promise.resolve();
    this.recorded.set(run.id, files);
    return record(this.options.agents.dir, was === undefined ? outcomeOf(run.id, run.agentId, learning) : notesLineOf(run.id, run.agentId, learning)).catch((error: Error) => {
      if (was === undefined) this.recorded.delete(run.id);
      else this.recorded.set(run.id, was);
      warn(run.id, `${was === undefined ? "its learning's end is" : "the notes it was given and read are"} not in the ledger yet: ${error.message}`);
    });
  }

  /** A run read at a start, before the kernel holds it, `save` writing its serve.json: one a server went down while it
   *  copied the run's seed (running, its input saved and no learning, and a pin or a `work/.learning/` there) has both
   *  taken back, so it starts again with nothing learned, and its learning dropped as `seed_failed`, saved before the
   *  ledger's line (onSaved). Called before anything reads the run: its relaunch, a settle, a follow-up. A seed_failed
   *  run asks no end-of-run turn (reflectSkip). A copy that never began leaves nothing, and the learning stays null. */
  async onLoad(row: Pick<RunRow, "id" | "agent" | "state">, dir: string, meta: Run["meta"], save: () => Promise<void>): Promise<void> {
    if (row.state !== "running" || meta.learning || !(await dropSeed(dir, localWorkspace(join(dir, "work"))))) return;
    meta.learning = { state: "dropped", reason: "seed_failed", detail: said.stopped(STOPPED.serverStopped), at: new Date().toISOString() };
    await save();
    warn(row.id, "its server stopped while it copied what its agent learned; it starts again with nothing learned");
    await this.onSaved({ id: row.id, agentId: row.agent }, meta.learning);
  }

  /** A run that learns, opened again for a follow-up, before its process starts: `work/.learning/` laid again from its
   *  seed where the run took it away, so the follow-up finds the notes its instructions name where they say, and the
   *  learned skills its pin names laid again, fresh, so its process reads each where it was. A fault leaves it without. */
  async onReopen(run: Run): Promise<void> {
    await learningTestHooks.beforeReopen?.(run.dir);
    const work = localWorkspace(join(run.dir, "work"));
    if (!run.meta.reflect) return;
    try {
      const pin = await readPin(run.dir);
      const copied = await work.list(LEARNED_DIR).then(() => true, (error: unknown) => !isWorkspaceError(error, "NOT_FOUND"));
      if (pin && !copied) await layLearned(work, await seedAt(this.options.agents.dir, run.agentId, pin.seed), this.shown());
      if (pin) await layPinnedSkills(work, pin, () => skillsAt(this.options.agents.dir, run.agentId, pin.seed));
    } catch (error) {
      warn(run.id, `opens again without its copy of what its agent learned: ${(error as Error).message}`);
    }
  }

  /** The server's start: the learning ledger read from now, beside the running runs' pass, never before it (a line
   *  written twice meanwhile is read once). What comes back takes every run once that pass is done: a learning end saved
   *  and not in the ledger (a server that went between the two) is written there. */
  recover(): (rows: readonly RunRow[]) => Promise<void> {
    const inLedger = outcomes(this.options.agents.dir).catch(() => new Map<string, Outcome>());
    return async (rows) => {
      for (const [run, line] of await inLedger) this.recorded.set(run, filesKey(lineNotesOf(line)));
      for (const row of rows) {
        if (row.state === "running" || row.importedFrom || row.kind !== "agentic") continue;
        const meta = (await readJson(join(runDirIn(this.options.agents.dir, row.agent, row.id), RUN_META))) as Partial<Run["meta"]> | null;
        const learning = isObject(meta?.learning) ? meta.learning : undefined;
        await this.onSaved({ id: row.id, agentId: row.agent }, learning);
      }
    };
  }

  /** The secrets this server never shows as they are now (serverSecrets), as a reader cuts them (secretsShown), as the
   *  learning routes cut them. Built again only once they change. Every run's view and every row of a list asks it, so
   *  the saved keys, which are read from their file and opened one by one, are read once and kept until a person saves
   *  or deletes one (keysChanged); the rest is read each time. */
  shown(): Shown {
    const saved = (this.saved ??= new Map(SECRET_NAMES.map((name) => [name, this.options.storedKeys?.(name)])));
    const values = this.options.serverSecrets((name) => saved.get(name));
    const key = values.join("\0");
    if (this.cut?.key !== key) this.cut = { key, shown: secretsShown(values) };
    return this.cut.shown;
  }

  /** A key was saved on this server or deleted from it: the next view reads them again. */
  keysChanged(): void {
    this.saved = undefined;
  }

  /** Agent `agentId`'s run's `learning` as it reads now (learning.ts currentLearning): what it held for its owner's OK
   *  checked against the folder's main (learning-routes.ts statusesOf, one read per commit of main). Its record stays as
   *  the merge wrote it; one that held nothing is read as it is, with no read of the folder. */
  async current(agentId: string, learning: Learning | undefined): Promise<Learning | undefined> {
    if (!holdsForOk(learning)) return learning;
    return currentLearning(learning, await statusesOf(this.options.agents.dir, agentId));
  }

  /** `rows` with their learning row as it reads now (current): its words from what it held, checked against main. */
  async rowsNow(agentId: string, learning: Learning | undefined, rows: readonly TimelineEvent[]): Promise<TimelineEvent[]> {
    const now = await this.current(agentId, learning);
    if (now === learning || !now) return [...rows];
    const [row] = withLearning([], now, this.shown()) as (TimelineEvent & { learning?: unknown })[];
    return rows.map((one) => (one.kind === "learning" && row ? ({ ...one, summary: row.summary, text: row.text, learning: row.learning } as TimelineEvent) : one));
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
    const heldOf = (id: string) => {
      const held = this.kernel.held(id);
      if (!held) return undefined;
      const learning = held.meta.learning;
      return learning ? { state: learning.state, reason: learning.reason } : null;
    };
    return learningStats(rows, filter, (row) => heldOf(row.id) ?? ledger.get(row.id) ?? null);
  }

  /** Agent `agentId`'s runs (`rows`, its own) as its learning view counts them, the ledger read once: how they fared
   *  (counts, less `runs`), and what learning changed (learningImpact), each run's learning from memory when the kernel
   *  holds it, else its end from its ledger line; never a run's files. */
  async ofAgent(rows: readonly RunRow[], agentId: string): Promise<{ counts: Omit<ReturnType<typeof learningStats>, "runs">; impact: Impact; notes: NoteRuns }> {
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
    // Each note's runs: given it and read it, a held run's from memory, an ended one's from its ledger line.
    const notes = noteRuns(rows.map((row) => {
      const held = this.kernel.held(row.id);
      if (held) return held.meta.learning ? notesOf(held.meta.learning) : null;
      const line = ledger.get(row.id);
      return line ? lineNotesOf(line) : null;
    }));
    return { counts, impact: learningImpact(rows, learningOf), notes };
  }

  // ---- the run's learning ---------------------------------------------------------------------------------------------

  /** What a run of `agentId` starts from: its learning folder's main (learning.ts seedOf, through the folder's script
   *  and file API), the folder made first when it is absent, with the lines its read said (a skill it left out); else
   *  why it starts with nothing learned. A learning fault never refuses a run: a folder that cannot be made or read is
   *  said once per run. */
  private async seedFor(agentId: string): Promise<{ seed: Seed; warned: string[] } | { failed: string }> {
    const warned: string[] = [];
    return seedOf(this.options.agents.dir, agentId, (line) => warned.push(line)).then((seed) => ({ seed, warned }), (error: Error) => {
      process.stderr.write(`agentrun-serve: the agent ${agentId}'s learning folder could not be read, so its run starts with nothing learned: ${error.message}\n`);
      return { failed: said.stopped(STOPPED.unreadable) };
    });
  }
}
