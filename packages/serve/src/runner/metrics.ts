// The run's metrics and cost for its end commit, from its journal. This is the old per-run end path's metrics
// computation (serve/src/runs.ts storedMetrics) moved onto the runner: the token, request and tool counts are the
// timeline's own (runMetricsWithDecisions), and the cost is the run's usage row read the same way the old costOf read it,
// so no money rule changes. The end commit stages the result on the run's row: `metrics` as the StoredMetrics JSON that
// the stats and analytics readers read, and `costUsd` as the row's cost.
//
// A pi run has no workflow decision receipts, so the decisions list is empty; a workflow run (when it joins the runner)
// passes its decisions. `effort` is the level the run ran at and `model`, on a harness other than pi, the model its
// revision named — both as storedMetrics added them, resolved by the caller from the run's launch and harness.
import { type DecisionLike, type EntryLike, runMetricsWithDecisions, type RunMetrics, timelineOf } from "@parcha/pi-durable-agent/timeline";

/** A run's metrics as the end commit writes them (the StoredMetrics JSON on the run row): the timeline's count, with the
 *  effort the run ran at and, on a harness other than pi, the model its revision named. */
export type RunMetricsStored = RunMetrics & { effort?: string; model?: string };

/** The run's metrics and cost from its journal `entries`. `decisions`: a workflow run's receipts (none for pi).
 *  `effort`/`model`: the enrichment the old storedMetrics added. `costUsd` is the usage row's cost: null when a
 *  response's cost is unknown, 0 before any request (costOf). */
export function runMetrics(
  entries: readonly EntryLike[],
  options: { readonly decisions?: readonly DecisionLike[]; readonly effort?: string; readonly model?: string } = {},
): { metrics: RunMetricsStored; costUsd: number | null } {
  const counted = runMetricsWithDecisions(entries, options.decisions ?? []);
  // The run's cost from its usage row, as serve/src/runs.ts costOf reads it: the usage row's usd (null unknown, 0 before
  // any request). The usage row is the one the settled timeline appends from the run's request-cost marks.
  const usage = timelineOf(entries, { settled: true }).findLast((row) => row.kind === "usage");
  const costUsd = usage ? (usage.usage?.usd ?? null) : 0;
  return {
    metrics: { ...counted, ...(options.effort !== undefined ? { effort: options.effort } : {}), ...(options.model !== undefined ? { model: options.model } : {}) },
    costUsd,
  };
}
