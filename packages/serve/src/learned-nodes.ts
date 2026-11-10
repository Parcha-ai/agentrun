// What a learned_workflow call keeps of its workflow's run beside itself in the run's journal: each node that ran, as
// the workflow DSL ended it (learned-workflow.ts runLearned writes it; store-reads/journal.ts runTimeline puts it on the
// call's result row as `learned_nodes`). Its own module, so the timeline's reader needs none of the tool's imports.

/** The journal entry a learned_workflow call keeps beside itself: `{ call, workflow, nodes }`, its call's id, the
 *  workflow's name and each of its nodes that ran (LearnedNode). */
export const LEARNED_NODES = "agentrun.learned_nodes";
/** The most nodes a call keeps: a map over a long list runs its body once per item. */
export const LEARNED_NODES_MAX = 64;
/** One node of a learned workflow's run, as the DSL ended it (its `node.end` event): its label, its kind, how it ended
 *  (`ok`, `failed`, `escalated`), how long it took, and why it failed (at most 300 characters, as the DSL gives it). */
export type LearnedNode = { readonly label: string; readonly kind: string; readonly status: string; readonly duration_ms: number; readonly error?: string };
