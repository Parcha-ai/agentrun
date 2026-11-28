// A run's learning, as the server reads it from a run's rows and the runs' rows: its learning row once its learning
// ended (withLearning), how the runs that tried to learn fared (learningStats), and an agent's impact (learningImpact).
// Which rows its end-of-run turn made is reflect-range.ts's (reflects, labelled). The runner runs the end-of-run step
// itself (runner/reflect-hook.ts).
import type { RunRow } from "./agent-rows.js";
import type { AnalyticsFilter } from "./store-reads/analytics.js";
import type { TimelineEvent } from "./timeline/index.js";
import { detailShown, type Learning, LEARNING_LABEL, LEARNING_REASONS, type Shown } from "./learning.js";
import type { DroppedWork } from "./learning-work.js";

/** The run's learning row, once its learning merged or dropped (`seed_failed` included): its state, reason and detail,
 *  its summary the detail itself as the run's view says it (learning.ts detailShown: cut of the host's secrets now,
 *  `shown`, then cut short). One row, which says where the learning ended. */
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

/** A learning row for each piece of learning work the run dropped before it started (learning-work.ts droppedWorkOf: a
 *  check replay or a shadow its cap left too little for), at its time, its summary and detail the words its
 *  `learning_work.dropped` says. Added at each read, as the learning row is. */
export function withDroppedWork(rows: readonly TimelineEvent[], dropped: readonly DroppedWork[]): TimelineEvent[] {
  if (!dropped.length) return [...rows];
  const said = dropped.map((one, i) => ({
    id: `${LEARNING_LABEL}:dropped:${i}`, timestamp: one.at, created_at: one.at, kind: "learning" as const, summary: one.detail, agent_label: LEARNING_LABEL,
    tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: one.detail,
    learning: { state: "dropped" as const, reason: one.reason, detail: one.detail },
  }));
  return [...rows, ...said];
}

/** How the runs that tried to learn fared, over the runs the analytics' `from`, `to` and `agent` pick (by when they
 *  started, unarchived): `runs` with a learning block, `merged`, `dropped` by reason, and `in_progress` (seeded or
 *  reflecting: a run this server holds). A run with learning off, a workflow's or an imported one, has none, and is not
 *  counted. */
export function learningStats(rows: readonly RunRow[], filter: AnalyticsFilter, learningOf: (row: RunRow) => { state: string; reason: string | null } | null) {
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  const out = { runs: 0, merged: 0, dropped: {} as Record<string, number>, in_progress: 0 };
  for (const row of rows) {
    const at = Date.parse(row.startedAt);
    if (row.kind !== "agentic" || row.importedFrom || row.archivedAt || !(at >= from && at < to) || (filter.agent !== undefined && row.agent !== filter.agent)) continue;
    const learning = learningOf(row);
    // A reason this server does not give is not counted.
    if (!learning || (learning.reason !== null && !(LEARNING_REASONS as readonly string[]).includes(learning.reason))) continue;
    out.runs += 1;
    if (learning.state === "merged") out.merged += 1;
    else if (learning.state === "dropped") out.dropped[learning.reason ?? "unknown"] = (out.dropped[learning.reason ?? "unknown"] ?? 0) + 1;
    else out.in_progress += 1;
  }
  return out;
}

/** One side of an agent's impact: how many runs and their median time to the answer. What a run costs is the cost
 *  read's all-in figure (learning-cost.ts: the takeover's before and after, learning included) and what learning cost
 *  is its bill's `learning_usd`: never a second cost here. */
export type ImpactSide = { runs: number; median_duration_s: number };
export type Impact = { before: ImpactSide; after: ImpactSide } | null;

/** What a run's learning tells its impact, from its learning end and its launch: how it ended and when, how many learned
 *  items it started from (its corrections' lines and the learned workflows its claims laid) and when its answer was
 *  final. */
export type ImpactLearning = { state: string; reason: string | null; at: string; seed_corrections?: number; seed_workflows?: number; answered_at?: string };
/** How many learned items a run started from. */
const seededItems = (learning: ImpactLearning | null | undefined): number => (learning?.seed_corrections ?? 0) + (learning?.seed_workflows ?? 0);
/** The middle of `values` (the mean of the two middle ones when there is an even count). */
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const sideOf = (seconds: readonly number[]): ImpactSide => ({ runs: seconds.length, median_duration_s: Math.round(median(seconds) * 10) / 10 });
/** Completed run `row`'s seconds to its answer, `learning` what its learning says: one whose end-of-run step asked a
 *  model turn answered when its job ended; any other when its row ended. */
function secondsOf(row: RunRow, learning: ImpactLearning | null | undefined): number {
  const answered = learning?.answered_at !== undefined ? Date.parse(learning.answered_at) : Date.parse(row.endedAt!);
  return (answered - Date.parse(row.startedAt)) / 1000;
}
/** What learning changed for an agent, from its run rows (`rows`) and what its runs' learning says (`learningOf`),
 *  never a run's files. `after`: its completed agentic runs that started from at least one learned item (seededItems).
 *  `before`: its completed agentic runs that started before its first item, the earlier of its first merge's end and the
 *  start of its first run that started from one; none of them could have. Each side (sideOf, secondsOf): its median
 *  time to the answer in seconds to a tenth. An imported or archived run is on neither side, nor is a later one with
 *  learning off or seeded with nothing. Null unless both sides hold 2 runs or more. */
export function learningImpact(rows: readonly RunRow[], learningOf: (row: RunRow) => ImpactLearning | null | undefined): Impact {
  const done = rows.filter((row) => row.kind === "agentic" && !row.importedFrom && !row.archivedAt && row.state === "completed" && row.endedAt);
  const after = done.filter((row) => seededItems(learningOf(row)) > 0);
  const merges = rows.flatMap((row) => {
    const learning = learningOf(row);
    return learning?.state === "merged" ? [Date.parse(learning.at)] : [];
  });
  const first = Math.min(...merges, ...after.map((row) => Date.parse(row.startedAt)));
  const counted = (side: readonly RunRow[]) => side.map((row) => secondsOf(row, learningOf(row)));
  const [before, later] = [counted(done.filter((row) => Date.parse(row.startedAt) < first)), counted(after)];
  return before.length >= 2 && later.length >= 2 ? { before: sideOf(before), after: sideOf(later) } : null;
}
