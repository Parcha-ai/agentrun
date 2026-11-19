// A run's cost, line by line (GET /runs/{run_id}/usage): what one run used and what it cost, by the model its requests
// went to, by who charged for its paid tool calls, and by the browser provider whose session time it ran up. For the
// person who runs AgentRun and wants to know what a run cost and whose invoice each part lands on; anyone who accounts
// for runs reads the same lines. A quantity is as it was measured (tokens as reported, seconds unrounded), and its dollars
// are the figures the run's booking already holds, the ones `cost.usd` joins: nothing is priced here.
//
// Nothing is measured again. The lines are the run's booking (runner/metrics.ts bookedSpend) split by what each charge
// was: its model requests and its decisions by the model each was sent on (`tokens`), its paid tool calls by who charged
// for them (`tools`, with the calls that ran unpriced beside them), and its browser session time by its provider
// (`browser_time`, with the seconds its BROWSER_CHARGED records keep). Each part is read by bookedSpend itself, over the
// run's entries with only that part's requests left in, so a line's figure follows the one rule its sum does; and the
// lines join (costWordsOf) to `total`, which is the run's `cost.usd`: the same booking outside its end-of-run (learning)
// turn, as `cost.tools_usd` reads it (store-view.ts toolsUsdOverStore). That turn is the server's own work for the agent,
// not the run's task, and `cost.usd` leaves it out the same way. Unknown is never $0: a line whose charge is unknown says
// so (`usd` null, what is known beside it), and a run the server cannot split says why (`reason`) with no lines.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import { BROWSER_CHARGED } from "./cap.js";
import { launchOf } from "./handed-values.js";
import { inReflect, reflectRanges } from "./runner/end-of-run.js";
import { journalRecords } from "./runner/journal-reader.js";
import { KINDS } from "./runner/journal-kinds.js";
import { type BookedSpend, bookedSpend, type CostBasis, costBasisOf, costWordsOf, type CostWords } from "./runner/metrics.js";
import { unbookedCli } from "./store-reads/cap.js";
import { decisionsOverStore } from "./store-reads/decisions.js";
import { roundsOf } from "./store-reads/learning.js";
import { MODEL_PROVIDER } from "./model.js";
import type { RunLaunch } from "./run-launch.js";
import { FINAL_STATES, type Store } from "./store/index.js";
import { type EntryLike, TOOL_UNMETERED } from "./timeline/index.js";

/** The meters a run's lines are on: the contract's `tokens` and `browser_time`, and this server's `tools`. */
export type UsageMeter = "tokens" | "tools" | "browser_time";

/** One line of a run's cost: one model, one charger or one browser provider on a meter. Which it is: `model` and
 *  `provider` on `tokens` (the model the requests were sent on; the provider they went to, named only when the server
 *  sent them there itself, null behind a gateway), `charged_by` on `tools` (who charged for the calls), `provider` on
 *  `browser_time`; every other one null, and null where the record names none, never "". `quantity` in `unit`: tokens
 *  (input, cache read, cache write and output, as each request reported them), charges booked (one per paid call), or
 *  seconds of browser session time on this server's clock, unrounded; null when none was measured. `usd` and its words
 *  are the cost block's (CostWords): null when a charge is unknown, with `so_far_usd` and `unpriced` beside it;
 *  `upper_bound` when a cut request counts at its hold. Not the contract's UsageLine (GET /usage's, a sum over many
 *  runs by group): a line of one run. */
export type RunUsageLine = {
  meter: UsageMeter;
  model: string | null;
  provider: string | null;
  charged_by: string | null;
  quantity: number | null;
  unit: "token" | "call" | "second";
  basis: CostBasis;
  requests?: number;
  tokens?: { input: number; output: number; cache_read: number; cache_write: number };
  unmetered_requests?: number;
  not_metered_calls?: number;
} & CostWords;

/** Why a run has no lines: `running`, it is at work and its booking still moves; `not_booked`, its figure is not its
 *  booking's (an imported run's, a native or SDK run's harness's own, a CLI run whose model requests went past its proxy);
 *  `reopened`, a learning run a follow-up opened again, whose `cost.usd` is its first round's and whose booking can't be
 *  split by round. */
export type UsageReason = "running" | "not_booked" | "reopened";

export type RunUsage = {
  run_id: string;
  /** When the run ended: the moment its lines cover. Null while it is at work. A follow-up opens an ended run again
   *  (store/sqlite/run-patch.ts REOPEN_SET clears it), and its next end is a later one: a reader that keeps it beside the
   *  lines knows from a later read whether the run moved since. */
  ended_at: string | null;
  currency: "USD";
  /** The lines joined by the one rule (costWordsOf): the run's `cost.usd`, with what is known of it when it is unknown
   *  (`so_far_usd`, `unpriced`) and `upper_bound` when it is a bound. Null with no lines. */
  total: CostWords | null;
  lines: RunUsageLine[] | null;
  reason: UsageReason | null;
};

type Group = { meter: UsageMeter; name: string | null; provider?: string | null };

/** A workflow decision's receipt as the lines read it (store-reads/decisions.ts): by its `decision_id`, which its
 *  request's booking names (`decision:<id>`), the model and provider that answered it, and how its cost was reached. */
export type DecisionReceiptLike = { model?: unknown; provider?: unknown; cost_basis?: unknown; usage?: unknown };

/** `entries` with the run's booked requests (runner.request and runner.turn) left in only where `keep` says so of its
 *  turn; every other entry (each session's key among them) kept, so bookedSpend reads that part alone. */
function onlyRequests(entries: readonly EntryLike[], turnOf: (e: EntryLike) => string, keep: (turn: string) => boolean): EntryLike[] {
  return entries.filter((e) => !(e.kind === RUNNER_RECORDS.request || e.kind === RUNNER_RECORDS.turn) || keep(turnOf(e)));
}

/** Two bookings as one: their requests, tokens and figures summed; their cost parts kept for the join. */
function joined(parts: readonly BookedSpend[]): { parts: BookedSpend[]; requests: number; unmetered: number; tokens: BookedSpend["tokens"]; priced: BookedSpend["priced"] } {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const priced = { reported: 0, estimated: 0 };
  let requests = 0;
  let unmetered = 0;
  for (const part of parts) {
    requests += part.requests;
    unmetered += part.unmetered;
    priced.reported += part.priced.reported;
    priced.estimated += part.priced.estimated;
    for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[key] += part.tokens[key];
  }
  return { parts: [...parts], requests, unmetered, tokens, priced };
}

const ORDER: Record<UsageMeter, number> = { tokens: 0, tools: 1, browser_time: 2 };
const named = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** The provider a run's model requests on `model` went to, where this server sent them there itself: the run's own
 *  model's provider (its launch's), on a direct route. Null behind a gateway, whose upstream the server does not know,
 *  and for any other model (a workflow decision's), whose route the booking does not keep. */
function upstreamOf(model: string | null, launch: Pick<RunLaunch, "model"> | undefined): string | null {
  const pinned = launch?.model;
  if (!pinned || !model || pinned.provider === MODEL_PROVIDER) return null;
  return model === pinned.modelId || model === `${pinned.provider}/${pinned.modelId}` ? pinned.provider : null;
}

/** A run's lines from its journal `entries` (every conversation, in log order), its end-of-run turns already left out:
 *  its model requests and decisions by model (`tokens`), its paid calls by who charged (`tools`), its browser time by
 *  provider (`browser_time`); and their join, `total`. A meter with nothing booked has no line. `launch` names the
 *  run's own model's provider; `receipts`, a workflow's decisions by id, the model and provider each was answered on
 *  (its booking names the decision alone), which this server called itself. */
export function usageLinesOf(entries: readonly EntryLike[], launch?: Pick<RunLaunch, "model">, receipts: ReadonlyMap<string, DecisionReceiptLike> = new Map()): { lines: RunUsageLine[]; total: CostWords } {
  const conversation = (key: string) => entries.find((e) => e.kind === KINDS.sessionKey && (e.data as { key?: unknown } | undefined)?.key === key)?.data as { conversation?: unknown } | undefined;
  const paidConv = Number(conversation(TOOL_SESSION)?.conversation ?? Number.NaN);
  const conv = (e: EntryLike) => Number(e.conversationId);
  const turnOf = (e: EntryLike) => `${String(e.conversationId)}:${String((e.data as { turn?: unknown } | undefined)?.turn)}`;
  // A line is one meter, one name and, on `tokens`, one route: a model reached two ways (the run's own requests behind a
  // gateway, a decision on its provider) is two lines, never one labelled with either's provider.
  const keyOf = (group: Group) => `${group.meter}\u0000${group.name ?? ""}\u0000${group.provider ?? ""}`;
  // Each booked request's group, by its turn: a model request's or a decision's, the model its runner.request was sent on;
  // a paid charge's, who charged for it (`charged_by`), on browser_time when it is the browser's session time. A paid
  // charge settled at its provider's own figure says so on its request (`reported`). A decision's request names the
  // decision (`decision:<id>`): its receipt names the model and provider that answered it, and how its cost was reached.
  const groups = new Map<string, Group>();
  const reported = new Set<string>();
  const estimated = new Set<string>();
  // A decision's tokens are its receipt's: its booking keeps its cost, with no usage (the cap books it at none).
  const decisionTokens = new Map<string, { input: number; output: number }>();
  for (const e of entries) {
    if (e.kind !== RUNNER_RECORDS.request) continue;
    const d = (e.data ?? {}) as { model?: unknown; tool?: unknown; charged_by?: unknown; reported?: unknown };
    if (conv(e) === paidConv) groups.set(turnOf(e), { meter: d.tool === "browser" ? "browser_time" : "tools", name: named(d.charged_by) });
    else if (named(d.model)?.startsWith("decision:")) {
      const receipt = receipts.get(String(d.model).slice("decision:".length));
      // A receipt that names no model leaves `model` null: its provider is said as the provider, never as a model.
      groups.set(turnOf(e), receipt ? { meter: "tokens", name: named(receipt.model), provider: named(receipt.provider) } : { meter: "tokens", name: null, provider: null });
      if (receipt?.cost_basis === "reported") reported.add(turnOf(e));
      else if (receipt?.cost_basis === "estimate") estimated.add(turnOf(e));
      const usage = (receipt?.usage ?? undefined) as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
      const tokenCount = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
      const [input, output] = [tokenCount(usage?.input_tokens), tokenCount(usage?.output_tokens)];
      if (input !== undefined && output !== undefined) decisionTokens.set(turnOf(e), { input, output });
    } else groups.set(turnOf(e), { meter: "tokens", name: named(d.model), provider: upstreamOf(named(d.model), launch) });
    if (d.reported === true) reported.add(turnOf(e));
  }
  // A turn booked with no request of its own (an older record) is its session's: a model's with no name, a paid charge
  // with no charger. A turn given back or never sent used nothing, and says nothing of how a line was priced.
  const found = new Map<string, Group>();
  const turnKeys = new Map<string, string>();
  const unused = new Set<string>();
  // Answered turns whose booking kept no usage: bookedSpend counts each among `unmetered`.
  const noUsage = new Set<string>();
  for (const e of entries) {
    if (e.kind !== RUNNER_RECORDS.request && e.kind !== RUNNER_RECORDS.turn) continue;
    const group = groups.get(turnOf(e)) ?? (conv(e) === paidConv ? { meter: "tools" as const, name: null } : { meter: "tokens" as const, name: null, provider: null });
    if (!found.has(keyOf(group))) found.set(keyOf(group), group);
    turnKeys.set(turnOf(e), keyOf(group));
    const d = (e.data ?? {}) as { givenBack?: unknown; unsent?: unknown; usage?: unknown };
    if (e.kind === RUNNER_RECORDS.turn && (d.givenBack === true || d.unsent === true)) unused.add(turnOf(e));
    else if (e.kind === RUNNER_RECORDS.turn && d.usage === undefined) noUsage.add(turnOf(e));
  }
  // Browser seconds by provider, from the charges' own records on the root (BROWSER_CHARGED): the seconds each charge was
  // for, as the browser_time meter of GET /usage counts them.
  const seconds = new Map<string, number>();
  // Tool calls with no price, run outside the run's cost (an MCP tool its owner set none for, TOOL_UNMETERED), by who
  // would charge for them, as GET /usage's `not_metered_calls` counts them.
  const unpricedCalls = new Map<string, number>();
  for (const e of entries) {
    const d = (e.data ?? {}) as { tool?: unknown; seconds?: unknown; charged_by?: unknown };
    if (e.kind === TOOL_UNMETERED) {
      const group: Group = { meter: "tools", name: named(d.charged_by) };
      unpricedCalls.set(keyOf(group), (unpricedCalls.get(keyOf(group)) ?? 0) + 1);
      if (!found.has(keyOf(group))) found.set(keyOf(group), group);
      continue;
    }
    if (e.kind !== BROWSER_CHARGED || d.tool !== "browser" || typeof d.seconds !== "number" || !Number.isFinite(d.seconds)) continue;
    const group: Group = { meter: "browser_time", name: named(d.charged_by) };
    seconds.set(keyOf(group), (seconds.get(keyOf(group)) ?? 0) + d.seconds);
    if (!found.has(keyOf(group))) found.set(keyOf(group), group);
  }
  const lines: RunUsageLine[] = [];
  for (const group of found.values()) {
    const key = keyOf(group);
    const part = onlyRequests(entries, turnOf, (turn) => turnKeys.get(turn) === key);
    const booked = group.meter === "tokens" ? joined([bookedSpend(part, "model"), bookedSpend(part, "decisions")]) : joined([bookedSpend(part, "paid")]);
    const notMetered = unpricedCalls.get(key);
    // A part whose every request was given back (never sent) used nothing: no line, unless calls ran on it unpriced.
    if (booked.requests === 0 && group.meter !== "browser_time" && !notMetered) continue;
    const priced = booked.requests - booked.parts.reduce((sum, p) => sum + p.unpriced, 0);
    const turns = [...turnKeys].filter(([turn, k]) => k === key && !unused.has(turn)).map(([turn]) => turn);
    if (group.meter === "tokens") {
      // A decision's tokens from its receipt, where it says them; the request then reported usage, so it is not unmetered.
      const told = turns.filter((turn) => decisionTokens.has(turn));
      const input = booked.tokens.input + told.reduce((sum, turn) => sum + decisionTokens.get(turn)!.input, 0);
      const output = booked.tokens.output + told.reduce((sum, turn) => sum + decisionTokens.get(turn)!.output, 0);
      const { cacheRead, cacheWrite } = booked.tokens;
      const unmetered = Math.max(0, booked.unmetered - told.filter((turn) => noUsage.has(turn)).length);
      // A decision's booking keeps no price table's mark: its receipt says how its cost was reached.
      const priced = { reported: booked.priced.reported + turns.filter((turn) => reported.has(turn)).length, estimated: booked.priced.estimated + turns.filter((turn) => estimated.has(turn)).length };
      lines.push({ meter: "tokens", model: group.name, provider: group.provider ?? null, charged_by: null, quantity: input + output + cacheRead + cacheWrite, unit: "token", basis: costBasisOf({ priced }), ...costWordsOf(booked.parts), requests: booked.requests, tokens: { input, output, cache_read: cacheRead, cache_write: cacheWrite }, unmetered_requests: unmetered });
    } else if (group.meter === "tools") {
      // `reported` when every charge with a figure was settled at its provider's own (monid's answer says what it
      // charged); `estimate` when any was settled at a price this server holds (an MCP tool's owner's, Parallel's).
      const basis = priced <= 0 ? "unpriced" : turns.every((turn) => reported.has(turn)) ? "reported" : "estimate";
      // Calls that ran unpriced only: none booked, so nothing is charged on the line, by its owner's choice of no price.
      const words: CostWords = booked.requests === 0 ? { usd: 0 } : costWordsOf(booked.parts);
      lines.push({ meter: "tools", model: null, provider: null, charged_by: group.name, quantity: booked.requests, unit: "call", basis, ...words, ...(notMetered ? { not_metered_calls: notMetered } : {}) });
    } else {
      const s = seconds.get(key);
      // A browser's holds given back with no time charged (a call that held and used nothing, a provider priced at $0 with
      // no charge record) used nothing: no line.
      if (booked.requests === 0 && s === undefined) continue;
      // A browser provider whose time no charge booked (none, or each given back) still ran: its seconds with no figure.
      const words: CostWords = booked.requests === 0 ? { usd: null } : costWordsOf(booked.parts);
      lines.push({ meter: "browser_time", model: null, provider: group.name, charged_by: null, quantity: s === undefined ? null : Math.round(s * 1e6) / 1e6, unit: "second", basis: priced > 0 ? "estimate" : "unpriced", ...words });
    }
  }
  // Each meter by its name (a model, a charger, a browser provider; none first), `tokens` then by its route's provider.
  const sortKey = (line: RunUsageLine) => (line.meter === "tokens" ? `${line.model ?? ""}\u0000${line.provider ?? ""}` : line.meter === "tools" ? line.charged_by ?? "" : line.provider ?? "");
  lines.sort((a, b) => ORDER[a.meter] - ORDER[b.meter] || (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  // The join over the whole booking, never the lines' rounded figures: the same figure cost.usd is. A browser line whose
  // time no charge booked is unknown beside it: the total is too, with the booking's figure as what is known.
  const total = costWordsOf([bookedSpend(entries, "model"), bookedSpend(entries, "paid"), bookedSpend(entries, "decisions")]);
  const unbooked = lines.filter((line) => line.usd === null && line.meter === "browser_time" && line.so_far_usd === undefined).length;
  if (!unbooked) return { lines, total };
  const known = total.usd ?? total.so_far_usd ?? 0;
  return { lines, total: { usd: null, so_far_usd: known, unpriced: (total.usd === null ? (total.unpriced ?? 0) : 0) + unbooked } };
}

/** Run `runId`'s usage lines (GET /runs/{run_id}/usage); undefined for an unknown run. No lines (`reason`) while it is at
 *  work, for a run whose figure is not its booking's, and for a learning run a follow-up opened again: the cases where
 *  `cost.tools_usd` is null for the same reasons. Its state, launch, learning rounds and journal are read in one snapshot
 *  of the store (one moment): a follow-up that reopens the run between two reads can't put its requests under its end. */
export async function runUsageOverStore(store: Store, runId: string): Promise<RunUsage | undefined> {
  return store.snapshot(async (snapshot) => {
    const run = await snapshot.runs.get(runId);
    if (!run) return undefined;
    const ended = FINAL_STATES.includes(run.state) && run.endedAt !== null ? new Date(run.endedAt).toISOString() : null;
    const none = (reason: UsageReason): RunUsage => ({ run_id: runId, ended_at: reason === "running" ? null : ended, currency: "USD", total: null, lines: null, reason });
    if (!FINAL_STATES.includes(run.state)) return none("running");
    const launch = await launchOf(snapshot, runId);
    if (run.importedFrom || launch?.native || launch?.sdk) return none("not_booked");
    if ((await roundsOf(snapshot, runId)).length > 1) return none("reopened");
    const records = await journalRecords(snapshot.readJournal(runId), BACKGROUND_CONTEXT);
    if (unbookedCli(records.entries as never)) return none("not_booked");
    const turns = reflectRanges(records.submissions ?? [], records.entries);
    const entries = records.entries.filter((entry) => !inReflect(turns, Number(entry.id))) as EntryLike[];
    // A workflow's decision receipts, read only when it made a decision: the model and provider each was answered on.
    const decided = entries.some((e) => e.kind === RUNNER_RECORDS.request && String((e.data as { model?: unknown } | undefined)?.model ?? "").startsWith("decision:"));
    const receipts = decided ? new Map((await decisionsOverStore(snapshot, runId, BACKGROUND_CONTEXT)).map((receipt) => [String(receipt.decision_id ?? receipt.id), receipt])) : undefined;
    const { lines, total } = usageLinesOf(entries, launch, receipts);
    return { run_id: runId, ended_at: ended, currency: "USD", total, lines, reason: null };
  });
}
