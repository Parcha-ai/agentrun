// What a learned_workflow call keeps of its workflow's run beside itself in the run's journal: each node that ran, as
// the workflow DSL ended it (learned-workflow.ts runLearned writes it; store-reads/journal.ts runTimeline puts it on the
// call's result row as `learned_nodes`). Its own module, so the timeline's reader needs none of the tool's imports.
import type { Skipped } from "./learn/replay-calls.js";

/** The journal entry a learned_workflow call keeps beside itself, its record, whatever ran: `{ call, workflow, digest,
 *  caller, nodes, loops? }`, its call's id, the workflow's name and digest (runner/workflow-first.ts workflowDigest), who
 *  called it (`platform` or `agent`: learning-cost.ts WorkflowCaller), each of its nodes that ran (LearnedNode, at most
 *  LEARNED_NODES_MAX) and every loop exit (LoopRow), never capped (a map over more items than the trace holds keeps
 *  each); on a replay run's call that a write stopped (learn/replay-calls.ts: one the agent's recording does not have),
 *  `replay_skipped: { tool, step }` too; `ended`, how the workflow ended (LearnedEnded), on a call that ended; and
 *  `refused: true` on one refused before any node ran (it ran nothing). A run's `workflow_calls` read these
 *  (runner/workflow-calls.ts). */
export const LEARNED_NODES = "agentrun.learned_nodes";
/** How a learned workflow's call ended: `complete` (it answered), `escalated` (it handed back: an escalate node,
 *  however many nodes failed on the way and were recovered, a map's collected item say), or `failed` (it threw, or was
 *  refused before any node ran). */
export type LearnedEnded = "complete" | "escalated" | "failed";
/** The record of a learned_workflow call refused before the tool saw it (`refused`: it ran nothing), which the loop keeps
 *  where the tool never ran: the platform's call its gate refused (runner/adapter-loop.ts serveFirst), and an agent's its
 *  gate refused (adapter-loop.ts keepRefusedLearned). */
export const refusedRecord = (call: string, workflow: string, digest: string, caller: "platform" | "agent") => ({ call, workflow, digest, caller, nodes: [], ended: "failed" as LearnedEnded, refused: true as const });
/** The most nodes a call keeps: a map over a long list runs its body once per item. */
export const LEARNED_NODES_MAX = 64;
/** One node of a learned workflow's run, as the DSL ended it (its `node.end` event): its label, its kind, how it ended
 *  (`ok`, `failed`, `escalated`) and how long it took; a model node also the model it ran on (`model`, as the run's route
 *  names it) and the tier it named (`tier`, absent for none). Never why it failed: the DSL cuts that text at 300
 *  characters, which can leave the start of a secret the run's cut no longer recognizes, so none of it is kept. A call
 *  node has no model. */
export type LearnedNode = { readonly label: string; readonly kind: string; readonly status: string; readonly duration_ms: number; readonly model?: string; readonly tier?: string };
/** One loop's exit (the DSL's `loop.exited`): its label, how many passes its body ran and whether its `until` held (false:
 *  it reached maxIters). A compiled answer's quote re-pick (learn/check.ts repickLabels) is a loop of 2 until its quote
 *  check passes, marked `repick`: `iterations` 2 there is a re-pick, `met` whether it found its quotes; any other loop is
 *  unmarked. Rows, uncapped, are a run's metrics' `loops`, each naming the workflow whose call ran it (`workflow`). */
export type LoopRow = { readonly node: string; readonly iterations: number; readonly met: boolean; readonly repick?: true; readonly workflow?: string };

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
    const data = entry.data as { call?: unknown; nodes?: unknown; loops?: unknown } | undefined;
    if (typeof data?.call !== "string") return;
    // A loop's exit is a run's row (a loop over an empty map exits with no node ended).
    const made = [data.nodes, data.loops].some((rows) => Array.isArray(rows) && rows.length > 0);
    if (made) ran.add(data.call);
    if (made || !ran.has(data.call)) last.set(data.call, index);
  });
  return last;
}

/** A run's loop rows, from its root entries: every loop exit of every learned_workflow call (LEARNED_NODES `loops`), in
 *  order, each with its call's workflow, from the entry that counts for each call (learnedCallEntries). What its metrics
 *  keep as `loops`. */
export function loopsOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): LoopRow[] {
  const rows: LoopRow[] = [];
  const last = learnedCallEntries(entries);
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== LEARNED_NODES) continue;
    const data = entry.data as { loops?: unknown; workflow?: unknown; call?: unknown } | undefined;
    if (typeof data?.call === "string" && last.get(data.call) !== index) continue;
    if (!Array.isArray(data?.loops)) continue;
    const workflow = typeof data?.workflow === "string" ? data.workflow : undefined;
    for (const row of data.loops) if (row && typeof row === "object") rows.push(workflow ? { ...(row as LoopRow), workflow } : (row as LoopRow));
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
