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
import { billedToPlan, costOfParts, type CostParts, rebooked, RUNNER_RECORDS, type SessionRecord, sessionSpendOf, turnCostOf } from "@parcha/agentrun-kernel";
import { DECISION_SESSION, TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import { KINDS, WORKFLOW_SESSION } from "./journal-kinds.js";
import { anthropicModelId } from "../provider.js";
import { WORKFLOW_FIRST, WORKFLOW_FIRST_CALL } from "./workflow-first.js";

/** What a run's booking says one of its sessions spent: its requests (a hold given back unused is none), its cost's parts
 *  (the kernel's CostParts: `known`, the sum of the requests' own figures; `bounded` and `atMost`, the sum and count of
 *  cut requests booked at their hold, each the most it can have cost; `unpriced`, how many have no figure), `usd` their
 *  sum (null while one is unpriced), their tokens, and how many of the requests have no known tokens (`unmetered`: booked
 *  with no usage, or sent and never answered), in no token sum; and its requests by the model each was sent on (`models`:
 *  its runner.request's model, "" for one that names none). `free`: it booked requests, every one on a free model (its
 *  runner.turn's `free`: its known price $0 for every token), so its $0 says why. A reader that joins sessions, or says
 *  what is known of an unknown cost, takes the parts through costOfParts, never `usd` and `known` alone. */
/** `priced`: of its requests with a known figure (a plan's aside, which cost no dollars), how many the provider or its
 *  gateway priced (`reported`: the proxy's reportedCostOf or usageCostOf, its runner.turn keeping the table's figure beside
 *  it as `tableUsd`) and how many a price table did (`estimated`: its runner.turn's `estimated`, or a cut request's hold,
 *  or a native or SDK task's `aggregate` booking, its harness's own figure).
 *  A figure that is neither ($0 for a request refused or never sent, a charge settled through the cap) counts in neither.
 *  `plan`: of its requests, those billed to a person's plan (a ChatGPT plan's, chatgpt-plan.ts, or Claude Code's login's:
 *  its runner.turn's `billing` "plan", or, still in flight, its runner.request's `plan`), how many and their tokens (input,
 *  output and cache, as each booking reported them; none yet for one in flight). Each is $0 to the run by the kernel's one
 *  rule (turnCostOf), however it ended: the plan pays for it, so no reader counts it unpriced. Counted as `requests` is:
 *  a request booked twice is one. */
export type BookedSpend = { readonly usd: number | null; readonly known: number; readonly bounded: number; readonly unpriced: number; readonly atMost: number; readonly requests: number; readonly unmetered: number; readonly models: Readonly<Record<string, number>>; readonly tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; readonly priced: { readonly reported: number; readonly estimated: number }; readonly plan: { readonly requests: number; readonly tokens: number }; readonly free?: true };

/** A booking record's request, as every reader of a booking names it: its conversation and its turn. */
const turnOf = (e: EntryLike): string => `${String(e.conversationId)}:${String((e.data as { turn?: unknown } | undefined)?.turn)}`;

/** How a run's cost was reached, by how its model requests were priced: `reported` when every request priced had the
 *  provider's or its gateway's own figure (LiteLLM's `x-litellm-response-cost`, OpenRouter's usage `cost`); `estimate`
 *  when any was priced from a price table (the catalog, AGENT_MODEL_PRICE, a cut request's hold); `unpriced` when no
 *  request was priced (none was sent, or none had a figure). The run's cost block (`cost.basis`), its stored metrics
 *  (`costBasis`) and the sums over runs (GET /stats, GET /usage) say it in these words. */
export const COST_BASES = ["reported", "estimate", "unpriced"] as const;
export type CostBasis = (typeof COST_BASES)[number];

/** The basis of a booking's model requests (bookedSpend "model"): COST_BASES. */
export const costBasisOf = (spend: Pick<BookedSpend, "priced">): CostBasis => (spend.priced.estimated > 0 ? "estimate" : spend.priced.reported > 0 ? "reported" : "unpriced");

/** The basis of a sum of costs: `estimate` when any is, else `reported` when any is, else `unpriced`. */
export function joinedBasis(bases: Iterable<CostBasis>): CostBasis {
  let reported = false;
  for (const basis of bases) {
    if (basis === "estimate") return "estimate";
    if (basis === "reported") reported = true;
  }
  return reported ? "reported" : "unpriced";
}

/** A run's basis as its end stored it (its metrics' `costBasis`); an imported run's catalog estimate (import.ts stores
 *  `costBasis: "catalog"` beside `costUsdEst`, the figure store-reads/runs.ts costOfRun reads) is an `estimate`, at $0 too;
 *  a run that stored none (one that ended before the end stored it, a workflow's, a native, SDK or imported run's: their
 *  figures are the harness's) is an `estimate` when it cost anything, else `unpriced`. */
export function storedBasisOf(metrics: unknown, usd: number | null | undefined): CostBasis {
  const stored = (metrics as { costBasis?: unknown } | null | undefined)?.costBasis;
  if ((COST_BASES as readonly unknown[]).includes(stored)) return stored as CostBasis;
  if (stored === "catalog" && typeof usd === "number") return "estimate";
  return typeof usd === "number" && usd > 0 ? "estimate" : "unpriced";
}

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
 *  booking's. `side`: of the model requests, those booked as side calls (another model than the session's, or the host's
 *  own, as a learned workflow's node is: the proxy's `side`/`host`), which no answer of a pi run carries. */
export function bookedSpend(entries: readonly EntryLike[], which: "model" | "paid" | "decisions" | "side"): BookedSpend {
  const keyed = sessionConversations(entries);
  const paidConv = keyed.get(TOOL_SESSION);
  const decisionsConv = keyed.get(DECISION_SESSION);
  const conv = (e: EntryLike) => Number(e.conversationId);
  const model = (e: EntryLike) => conv(e) !== paidConv && conv(e) !== decisionsConv;
  // The side calls among the model requests: each request that says so, by its conversation and turn.
  const sides = new Set(entries.filter((e) => e.kind === RUNNER_RECORDS.request && model(e) && ((e.data as { side?: unknown; host?: unknown } | undefined)?.side === true || typeof (e.data as { host?: unknown } | undefined)?.host === "string")).map(turnOf));
  const chosen = (e: EntryLike) => (which === "paid" ? conv(e) === paidConv : which === "decisions" ? conv(e) === decisionsConv : which === "side" ? model(e) && sides.has(turnOf(e)) : model(e));
  const answered = new Set(entries.filter((e) => e.kind === RUNNER_RECORDS.turn && chosen(e)).map(turnOf));
  // The model each request was sent on, by its turn (its runner.request's `model`).
  const sentOn = new Map(entries.filter((e) => e.kind === RUNNER_RECORDS.request && chosen(e)).map((e) => [turnOf(e), (e.data as { model?: unknown } | undefined)?.model]));
  const models: Record<string, number> = {};
  const count = (e: EntryLike) => {
    const model = sentOn.get(turnOf(e));
    const name = typeof model === "string" ? model : "";
    models[name] = (models[name] ?? 0) + 1;
  };
  let known = 0;
  let bounded = 0;
  let unpriced = 0;
  let requests = 0;
  let unmetered = 0;
  let free = 0;
  let atMost = 0;
  let reported = 0;
  let estimated = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const plan = { requests: 0, tokens: 0 };
  // Each request is booked once, as the kernel's sessionSpendOf reads it: a second runner.turn of a turn already booked
  // (two bookings of one session that each read it open, a cut written twice) counts no money and no request again.
  const booked = new Set<string>();
  for (const e of entries) {
    if (!chosen(e)) continue;
    if (e.kind === RUNNER_RECORDS.request && !answered.has(turnOf(e))) {
      requests += 1;
      count(e);
      // One billed to a person's plan (its record's `plan`, Admitted.plan) is $0 to the run however it ends, as the
      // kernel's sessionSpendOf holds it: in flight it is a known $0 and one of the plan's requests, never unpriced.
      if (billedToPlan(e.data)) plan.requests += 1;
      else unpriced += 1;
      unmetered += 1;
      continue;
    }
    if (e.kind !== RUNNER_RECORDS.turn) continue;
    if (rebooked(booked, typeof (e.data as { turn?: unknown } | undefined)?.turn === "number" ? turnOf(e) : undefined)) continue;
    const d = (e.data ?? {}) as { usd?: unknown; bookedUsd?: unknown; rule?: unknown; cut?: unknown; atMost?: unknown; givenBack?: unknown; unsent?: unknown; free?: unknown; billing?: unknown; estimated?: unknown; aggregate?: unknown; tableUsd?: unknown; usage?: Partial<Record<keyof typeof tokens, unknown>> };
    if (d.givenBack === true || d.unsent === true) continue;
    requests += 1;
    count(e);
    if (d.free === true) free += 1;
    // Its own cost by the kernel's one rule (turnCostOf): an answer with no price of its own is unknown, never the hold it
    // was booked at for the cap; a request cut with no answer booked at its hold counts that figure, the most it can cost,
    // kept apart from the requests' own figures.
    const own = turnCostOf(d);
    if (own.usd === null) unpriced += 1;
    else if (own.atMost) (bounded += own.usd), (atMost += 1);
    else known += own.usd;
    // How its figure was reached (costBasisOf): a price table's (the proxy's `estimated`, or a hold), or the provider's own
    // (the proxy keeps the table's figure beside a reported one, `tableUsd`). A native or SDK task's one booking for the whole
    // task (`aggregate`, native-loop.ts and sdk-loop.ts) carries its harness's own figure, an estimate. A plan's request
    // costs no dollars: neither.
    if (own.usd !== null && d.billing !== "plan") {
      if (own.atMost || d.estimated === true || d.aggregate === true) estimated += 1;
      else if (d.tableUsd !== undefined) reported += 1;
    }
    // The booking keeps a request's usage only when it reported some (runner.ts tokensOf): one with none is unmetered.
    if (d.usage === undefined) unmetered += 1;
    if (d.billing === "plan") plan.requests += 1;
    for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) {
      if (typeof d.usage?.[key] !== "number") continue;
      tokens[key] += d.usage[key] as number;
      if (d.billing === "plan") plan.tokens += d.usage[key] as number;
    }
  }
  return { usd: unpriced ? null : known + bounded, known, bounded, unpriced, atMost, requests, unmetered, models, tokens, priced: { reported, estimated }, plan, ...(requests > 0 && free === requests ? { free: true as const } : {}) };
}

/** The run's decisions whose ids are in `ids` (each booked as `decision:<id>`), as bookedSpend reads its decisions, with
 *  every other decision left out: the ones a vendor charged as a paid call (store-reads/decisions.ts
 *  parallelChargedDecisions), which the run's tools figures count beside its paid tool calls. */
export function bookedDecisionsOf(entries: readonly EntryLike[], ids: ReadonlySet<string>): BookedSpend {
  const named = (e: EntryLike) => (e.data as { model?: unknown } | undefined)?.model;
  const kept = new Set(entries.filter((e) => e.kind === RUNNER_RECORDS.request && typeof named(e) === "string" && (named(e) as string).startsWith("decision:") && ids.has((named(e) as string).slice("decision:".length))).map(turnOf));
  return bookedSpend(entries.filter((e) => !(e.kind === RUNNER_RECORDS.request || e.kind === RUNNER_RECORDS.turn) || kept.has(turnOf(e))), "decisions");
}

/** What one call of a tool booked, over `entries` (every conversation of the run's journal, in log order), by the run's
 *  one rule (runCostOf): each request whose record names the call or one nested in it (`call`: `callId`, or
 *  `callId/...`), and each request of host work (a side or host call, a paid tool call, a decision) admitted after the
 *  call's start (`from`, an index in `entries`) and at or before its end (`to`). The caller holds the window to the one
 *  call (runner/workflow-calls.ts). $0 for none; null once one has no known cost, or one a crash cut is counted at its
 *  hold (`atMost`: the most it can cost, never what it cost). */
export function callCostOf(entries: readonly EntryLike[], callId: string, from: number, to: number): number | null {
  const kept = callTurnsOf(entries, callId, from, to);
  const cost = runCostOf(entries.filter((e) => !(e.kind === RUNNER_RECORDS.request || e.kind === RUNNER_RECORDS.turn) || kept.has(turnOf(e))));
  return cost.atMost > 0 ? null : cost.usd;
}

/** The turns of the requests call `callId` booked, by callCostOf's rule: each request whose record names it or one nested
 *  in it, and each of host work admitted in its window (`from` < at <= `to`; -1 for both: no window, those named alone).
 *  None: nothing was booked under the call. `proof`: the turns that prove the call spent (workflow-calls.ts bookedUnder),
 *  not its price: a harness's own side request (`side` with no host label: a CLI's request on another model, its title or
 *  summary helper, proxy.ts) is left out, as it is never the call's. */
export function callTurnsOf(entries: readonly EntryLike[], callId: string, from: number, to: number, proof = false): Set<unknown> {
  const keyed = sessionConversations(entries);
  const hosted = new Set([keyed.get(TOOL_SESSION), keyed.get(DECISION_SESSION)].filter((one) => one !== undefined));
  const ours = (e: EntryLike, at: number) => {
    const d = (e.data ?? {}) as { call?: unknown; host?: unknown; side?: unknown };
    if (typeof d.call === "string" && (d.call === callId || d.call.startsWith(`${callId}/`))) return true;
    return at > from && at <= to && (typeof d.host === "string" || (d.side === true && !proof) || hosted.has(Number(e.conversationId)));
  };
  return new Set(entries.flatMap((e, at) => (e.kind === RUNNER_RECORDS.request && ours(e, at) ? [turnOf(e)] : [])));
}

/** A sum of charges with its float noise rounded off, nothing more (as the decisions row rounds, decision-rows.ts): a
 *  decision costs millionths of a dollar, so a sum rounded to the millionth would lose it. */
const floatNoiseOff = (usd: number): number => Math.round(usd * 1e12) / 1e12;

/** A cost of charges as a usage row or a run's cost block says it (costsofar/1, cutathold/1), by the kernel's one rule
 *  (costOfParts) over `parts`, its float noise rounded off (floatNoiseOff): `usd` their sum, `upper_bound` when it counts
 *  a cut request at its hold, with `so_far_usd` the charges' own figures alone and `unpriced` how many it counts at their
 *  hold beside it; or, while one has no known cost, `usd` null, `so_far_usd` the charges' own figures alone and `unpriced`
 *  how many have none, held ones included. A bound always says its exact part, so whatever joins these words with more
 *  charges (usageParts, then this again) never has to take the bound for spend. A part that is null is a cost no one
 *  knows that says nothing of itself (a usage row of an older run with no costsofar/1 fields, decisions that could not be
 *  read): the cost is unknown and nothing is said beside it. `extraUnpriced`: charges with no figure beside the parts' (a
 *  CLI's model work no booking read). This is the one join: every reader that combines a usage row with more charges
 *  goes through it. */
export type CostWords = { readonly usd: number | null; readonly so_far_usd?: number; readonly unpriced?: number; readonly upper_bound?: true };
export function costWordsOf(parts: readonly (CostParts | null)[], extraUnpriced = 0): CostWords {
  if (parts.some((part) => part === null)) return { usd: null };
  const all = [...(parts as CostParts[]), { known: 0, bounded: 0, atMost: 0, unpriced: extraUnpriced }];
  const cost = costOfParts(all);
  const round = floatNoiseOff;
  if (cost.usd === null) return { usd: null, so_far_usd: round(cost.soFarUsd), unpriced: cost.unpriced };
  if (!cost.atMost) return { usd: round(cost.usd) };
  // The exact part: the charges' own figures, never a hold (costOfParts' soFarUsd counts the holds once every charge is).
  return { usd: round(cost.usd), so_far_usd: round(all.reduce((sum, part) => sum + part.known, 0)), unpriced: cost.atMost, upper_bound: true };
}

/** A usage row's cost (TimelineEvent.usage, or a cost block in the same words) as the kernel's parts, for a join
 *  (costWordsOf): an exact figure is `known`; a bound is its exact part (`so_far_usd`) known and the rest bounded over its
 *  `unpriced` holds, or, from a row that says no exact part, the whole bounded over one hold, never spend; an unknown cost
 *  is its known part and its unpriced count. Null: an unknown cost that says neither. No row (undefined): nothing spent. */
export function usageParts(usage: { readonly usd: number | null; readonly so_far_usd?: number; readonly unpriced?: number; readonly upper_bound?: true } | undefined): CostParts | null {
  if (usage === undefined) return { known: 0, bounded: 0, atMost: 0, unpriced: 0 };
  const said = usage.so_far_usd !== undefined && usage.unpriced !== undefined;
  if (usage.usd !== null && usage.upper_bound === true) {
    return said ? { known: usage.so_far_usd!, bounded: Math.max(0, usage.usd - usage.so_far_usd!), atMost: usage.unpriced!, unpriced: 0 } : { known: 0, bounded: usage.usd, atMost: 1, unpriced: 0 };
  }
  if (usage.usd !== null) return { known: usage.usd, bounded: 0, atMost: 0, unpriced: 0 };
  return said ? { known: usage.so_far_usd!, bounded: 0, atMost: 0, unpriced: usage.unpriced! } : null;
}

/** A run's cost, by the one rule every reader of it takes (the end's stored cost_usd, GET /runs/{id} and the runs list of
 *  an ended run): from its booking alone, over `entries`, every conversation of its journal: its model requests, its paid
 *  tool calls and its decisions, each request at what it was booked at (bookedSpend), joined by the kernel's costOfParts.
 *  `usd` is their sum, its float noise rounded off (floatNoiseOff); null (unknown) when any request has no known cost, with what is known of
 *  it (`known`: the requests' own figures alone, never a cut request's hold) and how many have none (`unpriced`, held ones
 *  included) beside it. `atMost`, while `usd` is known: how many of its figures are a cut request's hold, so the cost is at
 *  most `usd`. `requests`: how many requests the run booked (0: it booked none, and its cost is not this booking's to say).
 *  `unbooked`: a CLI harness's model worked with no request booked (cliModelWorked: its requests went past its model
 *  proxy), one charge with no price, so the cost is unknown, never the $0 an empty booking sums to. */
export type RunCost = CostParts & { readonly usd: number | null; readonly requests: number };
export function runCostOf(entries: readonly EntryLike[], { unbooked = false }: { readonly unbooked?: boolean } = {}): RunCost {
  const parts = [bookedSpend(entries, "model"), bookedSpend(entries, "paid"), bookedSpend(entries, "decisions")];
  const cost = costOfParts([...parts, { known: 0, bounded: 0, atMost: 0, unpriced: unbooked && parts[0]!.requests === 0 ? 1 : 0 }]);
  const round = floatNoiseOff;
  // Its parts as one (CostParts, so its words are costWordsOf([cost])): `known` the requests' own figures alone, a hold
  // never among them; while the cost is known, `bounded` and `atMost` its holds, else every hold counted in `unpriced`.
  const known = round(parts.reduce((sum, part) => sum + part.known, 0));
  const usd = cost.usd === null ? null : round(cost.usd);
  return { usd, known, bounded: usd === null ? 0 : Math.max(0, round(usd - known)), unpriced: cost.unpriced, atMost: cost.atMost ?? 0, requests: parts.reduce((sum, part) => sum + part.requests, 0) };
}

/** A run's cost as its end stores it (the run row's cost_usd and cost_upper_bound): its figure, and whether that is the most
 *  it can have cost (a request cut at its hold counted in it). An unknown cost is never a bound. */
export type EndCost = { readonly costUsd: number | null; readonly costUpperBound: boolean };
export const endCostOf = (cost: RunCost): EndCost => ({ costUsd: cost.usd, costUpperBound: cost.usd !== null && cost.atMost > 0 });

/** Whether a CLI harness's record (`entries`, its root's) shows the model at work: a model message, a tool call it made, or
 *  its end-of-run turn's answer. Each took a model request, so a run that shows one and booked none (its requests went
 *  past its model proxy) spent what no booking read: its cost is unknown, never $0. */
export function cliModelWorked(entries: readonly EntryLike[]): boolean {
  // A run its learned workflow served first and answered (runner/workflow-first.ts, the loop's WORKFLOW_FIRST entry) keeps
  // the step's call and the workflow's answer, as the model's message written with that entry (pi's too: adapter-loop.ts
  // serveFirst): neither took a model request of the run's agent. Only that one message is passed over: a model message
  // after it (a follow-up's answer, its look-back's) is the model at work, so with nothing booked its cost is unknown.
  const roleOf = (e: EntryLike) => (e.data as { role?: unknown } | undefined)?.role;
  const servedAt = entries.findLastIndex((e) => e.kind === WORKFLOW_FIRST && (e.data as { outcome?: unknown } | undefined)?.outcome === "answered");
  const servedAnswer = servedAt < 0 ? -1 : entries.slice(0, servedAt).findLastIndex((e) => e.kind === KINDS.message && roleOf(e) === "model");
  return entries.some((e, i) => {
    if (e.kind === KINDS.callStart) return (e.data as { callId?: unknown } | undefined)?.callId !== WORKFLOW_FIRST_CALL;
    if (e.kind === KINDS.message) return roleOf(e) === "model" && i !== servedAnswer;
    return e.kind === KINDS.endOfRunTurn && roleOf(e) === "model";
  });
}

/** Whether a run's record carries no cost of its own, so its usage row and its live spend are its booking's: a CLI
 *  harness's record (`cli`), or a workflow's (its model nodes' answers carry pi-ai's $0). A pi run's answers carry their
 *  booking (adapters/pi.ts afterResponse). */
export function costIsBooked(entries: readonly EntryLike[], cli: boolean): boolean {
  return cli || sessionConversations(entries).has(WORKFLOW_SESSION);
}

/** What the run has spent and holds as its cap reads it (the kernel's sessionSpendOf over every session's records: a
 *  request still out at its hold and bound), for a run whose cost is its booking: the figure a gate holds it to (the
 *  runs list says bookedListSpend). Null when one session's is unknown, never 0 for it. */
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

/** What a run whose cost is its booking has spent, as the runs list says it while the run goes on: every booked request at
 *  what it was booked at, never the hold of a request still out (a hold is no spend: the request settles at what it cost,
 *  which the cap's own reading, bookedCapSpend, holds it to meanwhile). Null when a booked request's figure is unknown. */
export function bookedListSpend(entries: readonly EntryLike[]): number | null {
  let spent = 0;
  const booking = new Set(entries.filter((e) => e.kind === RUNNER_RECORDS.request || e.kind === RUNNER_RECORDS.turn).map((e) => Number(e.conversationId)));
  for (const conversation of booking) {
    const read = sessionSpendOf(recordsIn(entries, conversation));
    for (const { turn, usd } of read.figures) {
      if (!read.answered.has(turn)) continue;
      if (usd === null) return null;
      spent += usd;
    }
  }
  return spent;
}

/** The booking records of `conversation`, as the kernel's session readers take them. */
const recordsIn = (entries: readonly EntryLike[], conversation: number): SessionRecord[] =>
  entries.filter((e) => Number(e.conversationId) === conversation && e.kind !== KINDS.sessionKey).map((e) => ({ kind: e.kind, data: (e.data ?? null) as SessionRecord["data"] }));

/** A run's metrics as the end commit writes them (the StoredMetrics JSON on the run row): the timeline's count, with the
 *  effort the run ran at and, on a harness other than pi, the model its revision named. */
export type RunMetricsStored = RunMetrics & { effort?: string; model?: string; costBasis?: CostBasis };

/** `counted` with each tool `catalog` names (an MCP tool's hashed wire name: store-reads/journal.ts hashedMcpOf) counted
 *  under its catalog name, `mcp:<server>/<tool>`, as the run's timeline names its calls; the analytics' top tools read
 *  the name a run's metrics key a tool by. Every other tool keeps the name it was called by. */
function catalogKeyed(counted: RunMetrics, catalog: ReadonlyMap<string, string> | undefined): RunMetrics {
  if (!catalog?.size) return counted;
  const tools: RunMetrics["tools"] = {};
  for (const [name, each] of Object.entries(counted.tools)) {
    const key = catalog.get(name) ?? name;
    const had = tools[key];
    tools[key] = had ? { calls: had.calls + each.calls, errors: had.errors + each.errors } : each;
  }
  return { ...counted, tools };
}

/** The run's metrics and cost from its journal `entries`. `decisions`: a workflow run's receipts (none for pi).
 *  `effort`/`model`: the enrichment the old storedMetrics added. `catalog`: the run's MCP tools called by a hashed wire
 *  name, each counted under its catalog name (catalogKeyed). `costUsd` is the usage row's cost: null when a response's
 *  cost is unknown, 0 before any request (costOf). */
export function runMetrics(
  entries: readonly EntryLike[],
  options: { readonly decisions?: readonly DecisionLike[]; readonly effort?: string; readonly model?: string; readonly catalog?: ReadonlyMap<string, string> } = {},
): { metrics: RunMetricsStored; costUsd: number | null } {
  const counted = catalogKeyed(runMetricsWithDecisions(entries, options.decisions ?? []), options.catalog);
  // The run's cost from its usage row, as serve/src/runs.ts costOf reads it: the usage row's usd (null unknown, 0 before
  // any request). The usage row is the one the settled timeline appends from the run's request-cost marks.
  const usage = timelineOf(entries, { settled: true }).findLast((row) => row.kind === "usage");
  // An exact reader: a cost that counts a hold (`upper_bound`) is the most the run can have cost, unknown here.
  const costUsd = usage ? (usage.usage?.upper_bound === true ? null : (usage.usage?.usd ?? null)) : 0;
  return {
    metrics: { ...counted, ...(options.effort !== undefined ? { effort: options.effort } : {}), ...(options.model !== undefined ? { model: options.model } : {}) },
    costUsd,
  };
}

/** A CLI harness's run (its record the loop's: claude-agent, codex, opencode): its metrics from `rootEntries`, its root
 *  conversation's record (its tools), with its tokens and model requests those of `booked`, its booking's (bookedSpend
 *  "model", which the caller reads once for the run's cost too: what its model proxy booked each request at,
 *  runner.turn's usage), since the harness's own record carries none; each request counted at `model`, the model its
 *  run chose. Tokens are not a price: a request answered at no known price, with its usage, is metered all the same. */
/** `byModel` (a booking's requests by the model each was sent on) under the names a run's metrics use: the run's own
 *  model, and a request that names none, as `run` (the model it chose, `provider/model`, through OpenRouter or dotted
 *  too); any other (a learned node's tier, the hosted search's model) as its request names it. A booked name is the run's
 *  when it is one model by the router's match: its last segment, dots as dashes (provider.ts anthropicModelId: the
 *  booking names Anthropic's id, claude-haiku-4-5, for a run that chose openrouter/anthropic/claude-haiku-4.5). */
function modelsOf(byModel: Readonly<Record<string, number>>, run: string): Record<string, number> {
  const same = (name: string) => anthropicModelId({ provider: "anthropic", modelId: name.slice(name.lastIndexOf("/") + 1) });
  const own = same(run);
  const out: Record<string, number> = {};
  for (const [model, n] of Object.entries(byModel)) {
    const name = model === "" || same(model) === own ? run : model;
    out[name] = (out[name] ?? 0) + n;
  }
  return out;
}

export function cliRunMetrics(rootEntries: readonly EntryLike[], booked: BookedSpend, options: { readonly effort?: string; readonly model: string; readonly catalog?: ReadonlyMap<string, string> }): RunMetricsStored {
  const { metrics: counted } = runMetrics(rootEntries, options);
  const { tokens } = booked;
  return { ...counted, input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, requests: booked.requests, unmetered: booked.unmetered, models: modelsOf(booked.models, options.model) };
}
