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
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import { KINDS } from "./journal-kinds.js";

/** What a run's booking says one of its sessions spent: its requests (a hold given back unused is none), their known
 *  sum, how many have no known cost, and their tokens. */
export type BookedSpend = { readonly usd: number | null; readonly known: number; readonly unpriced: number; readonly requests: number; readonly tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } };

/** What the run's booking (the kernel's runner.request and runner.turn records, the model proxy's own) says its requests
 *  cost, over `entries`, every conversation of the run's journal: its model requests (`model`: every session but the
 *  paid-tools one, TOOL_SESSION), or its paid tool calls (`paid`: that session alone). Each request at what it was booked
 *  at (`bookedUsd`, else its `usd`); one booked at no known cost makes the sum unknown (null), its known part kept. A CLI
 *  harness's own record carries no per-request cost: its model requests' cost is this, the booking's. */
export function bookedSpend(entries: readonly EntryLike[], which: "model" | "paid"): BookedSpend {
  const session = entries.find((e) => e.kind === KINDS.sessionKey && (e.data as { key?: unknown } | undefined)?.key === TOOL_SESSION);
  const paidConv = session ? (session.data as { conversation?: unknown }).conversation : undefined;
  let known = 0;
  let unpriced = 0;
  let requests = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const e of entries) {
    if (e.kind !== RUNNER_RECORDS.turn || (e.conversationId === paidConv) !== (which === "paid")) continue;
    const d = (e.data ?? {}) as { usd?: unknown; bookedUsd?: unknown; givenBack?: unknown; usage?: Partial<Record<keyof typeof tokens, unknown>> };
    if (d.givenBack === true) continue;
    requests += 1;
    const usd = typeof d.bookedUsd === "number" && Number.isFinite(d.bookedUsd) ? d.bookedUsd : typeof d.usd === "number" && Number.isFinite(d.usd) ? d.usd : null;
    if (usd === null) unpriced += 1;
    else known += usd;
    for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) if (typeof d.usage?.[key] === "number") tokens[key] += d.usage[key] as number;
  }
  return { usd: unpriced ? null : known, known, unpriced, requests, tokens };
}

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
