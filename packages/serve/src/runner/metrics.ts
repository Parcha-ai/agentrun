// The run's metrics and cost for its end commit, from its journal. This is the old per-run end path's metrics
// computation (serve/src/runs.ts storedMetrics) moved onto the runner: the token, request and tool counts are the
// timeline's own (runMetricsWithDecisions), and the cost is the run's usage row read the same way the old costOf read it,
// so no money rule changes. The end commit stages the result on the run's row: `metrics` as the StoredMetrics JSON that
// the stats and analytics readers read, and `costUsd` as the row's cost.
//
// A pi run has no workflow decision receipts, so the decisions list is empty; a workflow run (when it joins the runner)
// passes its decisions. `effort` is the level the run ran at and `model`, on a harness other than pi, the model its
// revision named — both as storedMetrics added them, resolved by the caller from the run's launch and harness.
import { type DecisionLike, type EntryLike, runMetricsWithDecisions, type RunMetrics, timelineOf } from "../timeline/index.js";
import { answeredUnpriced, RUNNER_RECORDS, type SessionRecord, sessionSpendOf } from "@parcha/agentrun-kernel";
import { DECISION_SESSION, TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import { KINDS, WORKFLOW_SESSION } from "./journal-kinds.js";

/** What a run's booking says one of its sessions spent: its requests (a hold given back unused is none), their known
 *  sum, how many have no known cost, and their tokens. */
export type BookedSpend = { readonly usd: number | null; readonly known: number; readonly unpriced: number; readonly requests: number; readonly tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } };

/** The conversation each of the run's sessions books in, by its key: the first `agentrun.session.key` entry naming it. */
function sessionConversations(entries: readonly EntryLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== KINDS.sessionKey) continue;
    const d = (e.data ?? {}) as { key?: unknown; conversation?: unknown };
    if (typeof d.key === "string" && !out.has(d.key) && Number.isFinite(Number(d.conversation))) out.set(d.key, Number(d.conversation));
  }
  return out;
}

/** What the run's booking (the kernel's runner.request and runner.turn records, the model proxy's own) says its requests
 *  cost, over `entries`, every conversation of the run's journal: its model requests (`model`: every session but the
 *  paid-tools one, TOOL_SESSION, and the decisions one, DECISION_SESSION), its paid tool calls (`paid`: the paid-tools
 *  session alone), or its decisions (`decisions`: that session alone, which their receipts also show, so no usage row
 *  counts them twice). Each request at what it was booked at (`bookedUsd`, else its `usd`); one booked at no known cost,
 *  or with no runner.turn yet (in flight, or cut off by a crash before its answer was booked), makes the sum unknown
 *  (null), its known part kept, as sessionSpendOf counts it. A CLI harness's own record carries no per-request cost, nor do
 *  a workflow's model nodes (pi-ai's $0 for a model it has no price for): their model requests' cost is this, the
 *  booking's. */
export function bookedSpend(entries: readonly EntryLike[], which: "model" | "paid" | "decisions"): BookedSpend {
  const keyed = sessionConversations(entries);
  const paidConv = keyed.get(TOOL_SESSION);
  const decisionsConv = keyed.get(DECISION_SESSION);
  const conv = (e: EntryLike) => Number(e.conversationId);
  const chosen = (e: EntryLike) => (which === "paid" ? conv(e) === paidConv : which === "decisions" ? conv(e) === decisionsConv : conv(e) !== paidConv && conv(e) !== decisionsConv);
  const turnOf = (e: EntryLike) => `${String(e.conversationId)}:${String((e.data as { turn?: unknown } | undefined)?.turn)}`;
  const answered = new Set(entries.filter((e) => e.kind === RUNNER_RECORDS.turn && chosen(e)).map(turnOf));
  let known = 0;
  let unpriced = 0;
  let requests = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const e of entries) {
    if (!chosen(e)) continue;
    if (e.kind === RUNNER_RECORDS.request && !answered.has(turnOf(e))) {
      requests += 1;
      unpriced += 1;
      continue;
    }
    if (e.kind !== RUNNER_RECORDS.turn) continue;
    const d = (e.data ?? {}) as { usd?: unknown; bookedUsd?: unknown; rule?: unknown; givenBack?: unknown; unsent?: unknown; usage?: Partial<Record<keyof typeof tokens, unknown>> };
    if (d.givenBack === true || d.unsent === true) continue;
    requests += 1;
    // An answer with no price of its own was booked at its hold for the cap (answeredUnpriced): as a cost it is unknown.
    const usd = answeredUnpriced(d) ? null : typeof d.bookedUsd === "number" && Number.isFinite(d.bookedUsd) ? d.bookedUsd : typeof d.usd === "number" && Number.isFinite(d.usd) ? d.usd : null;
    if (usd === null) unpriced += 1;
    else known += usd;
    for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) if (typeof d.usage?.[key] === "number") tokens[key] += d.usage[key] as number;
  }
  return { usd: unpriced ? null : known, known, unpriced, requests, tokens };
}

/** Whether a CLI harness's record (`entries`, its root's) shows the model at work: a model message, a tool call it made, or
 *  its end-of-run turn's answer. Each took a model request, so a run that shows one and booked none (its requests went
 *  past its model proxy) spent what no booking read: its cost is unknown, never $0. */
export function cliModelWorked(entries: readonly EntryLike[]): boolean {
  return entries.some((e) => {
    const role = (e.data as { role?: unknown } | undefined)?.role;
    return e.kind === KINDS.callStart || ((e.kind === KINDS.message || e.kind === KINDS.endOfRunTurn) && role === "model");
  });
}

/** Whether a run's record carries no cost of its own, so its usage row and its live spend are its booking's: a CLI
 *  harness's record (`cli`), or a workflow's (its model nodes' answers carry pi-ai's $0). A pi run's answers carry their
 *  booking (adapters/pi.ts afterResponse). */
export function costIsBooked(entries: readonly EntryLike[], cli: boolean): boolean {
  return cli || sessionConversations(entries).has(WORKFLOW_SESSION);
}

/** What the run has spent as its cap reads it (the kernel's sessionSpendOf over every session's records: a request still
 *  out at its hold and bound), for a run whose cost is its booking: the runs list's figure while it runs. Null when one
 *  session's is unknown, never 0 for it. */
export function bookedCapSpend(entries: readonly EntryLike[]): number | null {
  let spent = 0;
  // Every conversation that holds booking records, keyed or not, as bookedSpend reads them.
  const booking = new Set(entries.filter((e) => e.kind === RUNNER_RECORDS.request || e.kind === RUNNER_RECORDS.turn).map((e) => Number(e.conversationId)));
  for (const conversation of booking) {
    const records = entries.filter((e) => Number(e.conversationId) === conversation && e.kind !== KINDS.sessionKey).map((e) => ({ kind: e.kind, data: (e.data ?? null) as SessionRecord["data"] }));
    const read = sessionSpendOf(records).spentUsd;
    if (read === null) return null;
    spent += read;
  }
  return spent;
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
