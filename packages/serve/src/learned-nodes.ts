// What a learned_workflow call keeps of its workflow's run beside itself in the run's journal: each node that ran, as
// the workflow DSL ended it (learned-workflow.ts runLearned writes it; store-reads/journal.ts runTimeline puts it on the
// call's result row as `learned_nodes`). Its own module, so the timeline's reader needs none of the tool's imports.
import type { Skipped } from "./learn/replay-calls.js";

/** The journal entry a learned_workflow call keeps beside itself: `{ call, workflow, nodes, guards?, loops? }`, its call's
 *  id, the workflow's name, each of its nodes that ran (LearnedNode, at most LEARNED_NODES_MAX), every guard check it made
 *  (GuardRow) and every loop exit (LoopRow), these two never capped (a map over more items than the trace holds keeps
 *  each); on a replay run's call that a write
 *  stopped (learn/replay-calls.ts: one the graded run's recording does not have), `replay_skipped: { tool, step }` too; and
 *  `ended`, how the workflow ended (LearnedEnded), on a call that ended (a replay run's call always keeps its entry). */
export const LEARNED_NODES = "agentrun.learned_nodes";
/** How a learned workflow's call ended: `complete` (it answered), `escalated` (it handed back: an escalate node or a guard,
 *  however many nodes failed on the way and were recovered, a map's collected item say), or `failed` (it threw, or was
 *  refused before any node ran). */
export type LearnedEnded = "complete" | "escalated" | "failed";
/** The most nodes a call keeps: a map over a long list runs its body once per item. */
export const LEARNED_NODES_MAX = 64;
/** One node of a learned workflow's run, as the DSL ended it (its `node.end` event): its label, its kind, how it ended
 *  (`ok`, `failed`, `escalated`) and how long it took; a model node also the model it ran on (`model`, as the run's route
 *  names it) and the tier it named (`tier`, absent for none). Never why it failed: the DSL cuts that text at 300
 *  characters, which can leave the start of a secret the run's cut no longer recognizes, so none of it is kept. A call
 *  node has no model. */
export type LearnedNode = { readonly label: string; readonly kind: string; readonly status: string; readonly duration_ms: number; readonly model?: string; readonly tier?: string; readonly guard?: GuardRow };
/** One step guard's check (runner/step-guard.ts), on the node it guards: the step (its label, a child's prefixed), the
 *  guard's signal and threshold, the signals it read (raw probabilities: its own confidence `self`, Jev's yes `jev`),
 *  `p` (through the guard's fit when it has one; null when a signal it reads was missing, so it handed back) and whether
 *  it handed the job back. A run's rows are its metrics' `guards` (runner/workflow-first.ts pathMetrics), each naming
 *  the workflow whose call made it (`workflow`: a run can call more than one, the next after the first hands back).
 *  `escalate`: no guard but an escalate node a replay recorded instead of obeying (the DSL's softEscalates), on
 *  its label: p 0 when it fired, else 1, at SOFT_ESCALATE_THRESHOLD, never `escalated` (the run went on past it). */
export type GuardRow = { readonly node: string; readonly signal: "self" | "jev" | "both" | "escalate"; readonly self?: number; readonly jev?: number; readonly p: number | null; readonly threshold: number; readonly escalated: boolean; readonly workflow?: string };
/** One loop's exit (the DSL's `loop.exited`): its label, how many passes its body ran and whether its `until` held (false:
 *  it reached maxIters). A compiled answer's quote re-pick (learn/check.ts) is a loop of 2 until its quote check passes:
 *  `iterations` 2 is a re-pick, `met` whether it found its quotes. Rows, uncapped, are a run's metrics' `loops`, each
 *  naming the workflow whose call ran it (`workflow`), as `guards` are. */
export type LoopRow = { readonly node: string; readonly iterations: number; readonly met: boolean; readonly workflow?: string };

/** The LEARNED_NODES entry that counts for each learned_workflow call in `entries`, by the call's id, as its index in
 *  `entries`. A call run again (after a park or a crash: it nests calls) keeps an entry each time; the one that counts is
 *  its last that ran a node, made a check or exited a loop, as it holds every node and check its rerun made again. A rerun refused before
 *  any node ran (a replay run keeps that entry: `nodes: []`, ended `failed`) leaves the attempt before it standing; a call
 *  none of whose entries ran a node counts its last. What the run's guard rows (guardsOf) and its timeline rows'
 *  `learned_nodes` (store-reads/journal.ts) both read, so the two never pick apart. */
export function learnedCallEntries(entries: readonly { readonly kind: string; readonly data?: unknown }[]): Map<string, number> {
  const last = new Map<string, number>();
  const ran = new Set<string>();
  entries.forEach((entry, index) => {
    if (entry.kind !== LEARNED_NODES) return;
    const data = entry.data as { call?: unknown; nodes?: unknown; guards?: unknown; loops?: unknown } | undefined;
    if (typeof data?.call !== "string") return;
    // A loop's exit is a run's row as a check is (a loop over an empty map exits with no node ended).
    const made = [data.nodes, data.guards, data.loops].some((rows) => Array.isArray(rows) && rows.length > 0);
    if (made) ran.add(data.call);
    if (made || !ran.has(data.call)) last.set(data.call, index);
  });
  return last;
}

/** A run's guard rows, from its root entries: every guard check of every learned_workflow call (LEARNED_NODES `guards`,
 *  never the capped trace's), in order, each with its call's workflow, from the entry that counts for each call
 *  (learnedCallEntries). What its metrics keep as `guards`. */
export function guardsOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): GuardRow[] {
  return rowsOf<GuardRow>(entries, "guards");
}

/** A run's loop rows, from its root entries: every loop exit of every learned_workflow call (LEARNED_NODES `loops`), read
 *  as guardsOf reads `guards`. What its metrics keep as `loops`. */
export function loopsOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): LoopRow[] {
  return rowsOf<LoopRow>(entries, "loops");
}

/** The rows at `key` of each LEARNED_NODES entry that counts for its call (learnedCallEntries), in order, each with its
 *  call's workflow. */
function rowsOf<Row extends { readonly workflow?: string }>(entries: readonly { readonly kind: string; readonly data?: unknown }[], key: "guards" | "loops"): Row[] {
  const rows: Row[] = [];
  const last = learnedCallEntries(entries);
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== LEARNED_NODES) continue;
    const data = entry.data as { guards?: unknown; loops?: unknown; workflow?: unknown; call?: unknown } | undefined;
    if (typeof data?.call === "string" && last.get(data.call) !== index) continue;
    const kept = data?.[key];
    if (!Array.isArray(kept)) continue;
    const workflow = typeof data?.workflow === "string" ? data.workflow : undefined;
    for (const row of kept) if (row && typeof row === "object") rows.push(workflow ? { ...(row as Row), workflow } : (row as Row));
  }
  return rows;
}

/** How the newest learned_workflow call of `workflow` in `entries` (its root's) ended (LEARNED_NODES `ended`), or undefined
 *  when no entry says. */
export function endedIn(entries: readonly { readonly kind: string; readonly data?: unknown }[], workflow: string): LearnedEnded | undefined {
  const data = entries.findLast((entry) => entry.kind === LEARNED_NODES && (entry.data as { workflow?: unknown } | undefined)?.workflow === workflow)?.data as { ended?: unknown } | undefined;
  return data?.ended === "complete" || data?.ended === "escalated" || data?.ended === "failed" ? data.ended : undefined;
}

/** The write that stopped a replay run's workflow, from its root entries (a LEARNED_NODES entry's `replay_skipped`: a
 *  write the graded run's recording does not have, learn/replay-calls.ts; `unmarked`, an MCP tool listed with no
 *  readOnlyHint), or undefined when none did. */
export function replaySkippedIn(entries: readonly { readonly kind: string; readonly data?: unknown }[]): Skipped | undefined {
  for (const entry of entries) {
    if (entry.kind !== LEARNED_NODES) continue;
    const skipped = (entry.data as { replay_skipped?: { tool?: unknown; step?: unknown; unmarked?: unknown } } | undefined)?.replay_skipped;
    if (skipped && typeof skipped.tool === "string" && typeof skipped.step === "string") return { tool: skipped.tool, step: skipped.step, ...(skipped.unmarked === true ? { unmarked: true as const } : {}) };
  }
  return undefined;
}
