// What a learned_workflow call keeps of its workflow's run beside itself in the run's journal: each node that ran, as
// the workflow DSL ended it (learned-workflow.ts runLearned writes it; store-reads/journal.ts runTimeline puts it on the
// call's result row as `learned_nodes`). Its own module, so the timeline's reader needs none of the tool's imports.

/** The journal entry a learned_workflow call keeps beside itself: `{ call, workflow, nodes, guards? }`, its call's id, the
 *  workflow's name, each of its nodes that ran (LearnedNode, at most LEARNED_NODES_MAX) and every guard check it made
 *  (GuardRow, never capped: a map over more items than the trace holds keeps each). */
export const LEARNED_NODES = "agentrun.learned_nodes";
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
 *  it handed the job back. A run's rows are its metrics' `guards` (runner/workflow-first.ts pathMetrics). */
export type GuardRow = { readonly node: string; readonly signal: "self" | "jev" | "both"; readonly self?: number; readonly jev?: number; readonly p: number | null; readonly threshold: number; readonly escalated: boolean };

/** A run's guard rows, from its root entries: every guard check of every learned_workflow call (LEARNED_NODES `guards`,
 *  never the capped trace's), in order. What its metrics keep as `guards`. */
export function guardsOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): GuardRow[] {
  const rows: GuardRow[] = [];
  for (const entry of entries) {
    if (entry.kind !== LEARNED_NODES) continue;
    const guards = (entry.data as { guards?: unknown } | undefined)?.guards;
    if (!Array.isArray(guards)) continue;
    for (const row of guards) if (row && typeof row === "object") rows.push(row as GuardRow);
  }
  return rows;
}
