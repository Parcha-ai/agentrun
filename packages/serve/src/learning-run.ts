// A run's learning, as the server reads it from a run's rows and the runs' rows: the notes it read (notesRead), its
// learning row once its learning ended (withLearning), how the runs that tried to learn fared (learningStats), and an
// agent's impact (noteRuns, learningImpact). Which rows its end-of-run turn made is reflect-range.ts's (reflects,
// labelled). The runner runs the end-of-run turn itself (runner/reflect-hook.ts).
import { posix } from "node:path";
import { INDEX_FILE } from "./learn/index.js";
import { type AnalyticsFilter, type RunRow } from "@parcha/pi-durable-agent";
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { detailShown, LEARNED_DIR, type Learning, type NoteRuns, LEARNING_LABEL, LEARNING_REASONS, type Shown } from "./learning.js";
import { type Reflect, reflects } from "./reflect-range.js";
import type { NoteFiles } from "./usage.js";

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
  // No store entry makes it: the served view adds it at each read, and learning that starts over (seeded, reflecting)
  // has none.
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
export type ImpactLearning = { state: string; reason: string | null; at: string; seed_notes?: number; seed_skills?: number; seed_workflows?: number; answered_at?: string; job_cost_usd?: number | null; look_back_usd?: number | null; grade_usd?: number | null };
/** How many learned items a run started from: its notes, the learned skills it was offered and the learned workflows its
 *  learned_workflow tool could run. */
const seededItems = (learning: ImpactLearning | null | undefined): number => (learning?.seed_notes ?? 0) + (learning?.seed_skills ?? 0) + (learning?.seed_workflows ?? 0);
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
 *  never a run's files. `after`: its completed agentic runs that started from at least one learned item: an active note,
 *  a learned skill it was offered or a learned workflow its learned_workflow tool could run (seededItems). `before`: its
 *  completed agentic runs that started before its first item, the earlier of its first merge's end and the start of its
 *  first run that started from one (a person's note comes first that way); none of them could have. Each side's
 *  figures (sideOf, figuresOf): its time to the answer in seconds to a tenth, its job's own cost, what learning cost.
 *  An imported or archived run is on neither side, nor is a later one with learning off or seeded with no note (every
 *  note retired), nor one whose learning predates these figures. Null unless both sides hold 2 runs or more. */
export function learningImpact(rows: readonly RunRow[], learningOf: (row: RunRow) => ImpactLearning | null | undefined): Impact {
  const done = rows.filter((row) => row.kind === "agentic" && !row.importedFrom && !row.archivedAt && row.state === "completed" && row.endedAt);
  const after = done.filter((row) => seededItems(learningOf(row)) > 0);
  const merges = rows.flatMap((row) => {
    const learning = learningOf(row);
    return learning?.state === "merged" ? [Date.parse(learning.at)] : [];
  });
  const first = Math.min(...merges, ...after.map((row) => Date.parse(row.startedAt)));
  const counted = (side: readonly RunRow[]) => side.flatMap((row) => figuresOf(row, learningOf(row)) ?? []);
  const [before, later] = [counted(done.filter((row) => Date.parse(row.startedAt) < first)), counted(after)];
  return before.length >= 2 && later.length >= 2 ? { before: sideOf(before), after: sideOf(later) } : null;
}

