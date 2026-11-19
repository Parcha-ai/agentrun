// A run's usage lines (GET /runs/{run_id}/usage): what one run used, a line per meter and dimension, each with its raw
// quantity and this server's own cost figure and how that figure was reached, for an operator who bills or accounts for
// runs. The server prices nothing for anyone here: a quantity is as it was measured (tokens as reported, seconds
// unrounded), and its dollars are the figures the run's booking already holds, the ones `cost.usd` joins.
//
// Nothing is measured again. The lines are the run's booking (runner/metrics.ts bookedSpend) split by what each charge
// was: its model requests and its decisions by the model each was sent on (`tokens`), its paid tool calls by who charged
// for them (`tools`), and its browser session time by its provider (`browser_time`, with the seconds its BROWSER_CHARGED
// records keep). Each part is read by bookedSpend itself, over the run's entries with only that part's requests left in,
// so a line's figure follows the one rule its sum does; and the lines join (costWordsOf) to `total_usd`, which is the run's
// `cost.usd`: the same booking, outside its end-of-run (learning) turn, as `cost.tools_usd` reads it (store-view.ts
// toolsUsdOverStore). Unknown is never $0: a line whose charge is unknown says so (`usd` null, what is known beside it),
// and a run the server cannot split says why (`reason`) with no lines.
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
import { roundsOf } from "./store-reads/learning.js";
import { FINAL_STATES, type Store } from "./store/index.js";
import type { EntryLike } from "./timeline/index.js";

/** The meters a run's lines are on: the contract's `tokens` and `browser_time`, and this server's `tools`. */
export type UsageMeter = "tokens" | "tools" | "browser_time";

/** One line: `dimension` says which part of the meter it is (a model, who charged, a browser provider; "" when the
 *  record names none). `quantity` in `unit`: tokens (input, cache read, cache write and output, as each request reported
 *  them), charges booked (one per paid call), or seconds of browser session time on this server's clock, unrounded; null
 *  when none was measured. `usd` and its words are the cost block's (CostWords): null when a charge is unknown, with
 *  `so_far_usd` and `unpriced` beside it; `upper_bound` when a cut request counts at its hold. */
export type UsageLine = {
  meter: UsageMeter;
  dimension: string;
  quantity: number | null;
  unit: "token" | "call" | "second";
  basis: CostBasis;
  requests?: number;
  tokens?: { input: number; output: number; cache_read: number; cache_write: number };
  unmetered_requests?: number;
} & CostWords;

/** Why a run has no lines: `running`, it is at work and its booking still moves; `not_booked`, its figure is not its
 *  booking's (an imported run's, a native or SDK run's harness's own, a CLI run whose model requests went past its proxy);
 *  `reopened`, a learning run a follow-up opened again, whose `cost.usd` is its first round's and whose booking can't be
 *  split by round. */
export type UsageReason = "running" | "not_booked" | "reopened";

export type RunUsage = {
  run_id: string;
  /** The run ended and its record no longer moves: these lines are its last. */
  final: boolean;
  currency: "USD";
  /** The lines joined by the one rule (costWordsOf): the run's `cost.usd`. Null with no lines, or when a line's is. */
  total_usd: number | null;
  lines: UsageLine[] | null;
  reason: UsageReason | null;
};

type Group = { meter: UsageMeter; dimension: string };

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

/** A run's lines from its journal `entries` (every conversation, in log order), its end-of-run turns already left out:
 *  its model requests and decisions by model (`tokens`), its paid calls by who charged (`tools`), its browser time by
 *  provider (`browser_time`); and their join, `total_usd`. A meter with nothing booked has no line. */
export function usageLinesOf(entries: readonly EntryLike[]): { lines: UsageLine[]; total_usd: number | null } {
  const conversation = (key: string) => entries.find((e) => e.kind === KINDS.sessionKey && (e.data as { key?: unknown } | undefined)?.key === key)?.data as { conversation?: unknown } | undefined;
  const paidConv = Number(conversation(TOOL_SESSION)?.conversation ?? Number.NaN);
  const conv = (e: EntryLike) => Number(e.conversationId);
  const turnOf = (e: EntryLike) => `${String(e.conversationId)}:${String((e.data as { turn?: unknown } | undefined)?.turn)}`;
  // Each booked request's group, by its turn: a model request's or a decision's, the model its runner.request was sent on;
  // a paid charge's, who charged for it (`charged_by`), on browser_time when it is the browser's session time.
  const groups = new Map<string, Group>();
  for (const e of entries) {
    if (e.kind !== RUNNER_RECORDS.request) continue;
    const d = (e.data ?? {}) as { model?: unknown; tool?: unknown; charged_by?: unknown };
    const by = typeof d.charged_by === "string" ? d.charged_by : "";
    if (conv(e) === paidConv) groups.set(turnOf(e), d.tool === "browser" ? { meter: "browser_time", dimension: by } : { meter: "tools", dimension: by });
    else groups.set(turnOf(e), { meter: "tokens", dimension: typeof d.model === "string" ? d.model : "" });
  }
  // A turn booked with no request of its own (an older record) is its session's: a model's with no name, a paid charge
  // with no charger.
  const keyOf = (group: Group) => `${group.meter}\u0000${group.dimension}`;
  const found = new Map<string, Group>();
  const turnKeys = new Map<string, string>();
  for (const e of entries) {
    if (e.kind !== RUNNER_RECORDS.request && e.kind !== RUNNER_RECORDS.turn) continue;
    const group = groups.get(turnOf(e)) ?? (conv(e) === paidConv ? { meter: "tools", dimension: "" } : { meter: "tokens", dimension: "" });
    found.set(keyOf(group), group);
    turnKeys.set(turnOf(e), keyOf(group));
  }
  // Browser seconds by provider, from the charges' own records on the root (BROWSER_CHARGED): the seconds each charge was
  // for, as the browser_time meter of GET /usage counts them.
  const seconds = new Map<string, number>();
  for (const e of entries) {
    const d = (e.data ?? {}) as { tool?: unknown; seconds?: unknown; charged_by?: unknown };
    if (e.kind !== BROWSER_CHARGED || d.tool !== "browser" || typeof d.seconds !== "number" || !Number.isFinite(d.seconds)) continue;
    const by = typeof d.charged_by === "string" ? d.charged_by : "";
    seconds.set(by, (seconds.get(by) ?? 0) + d.seconds);
    if (!found.has(keyOf({ meter: "browser_time", dimension: by }))) found.set(keyOf({ meter: "browser_time", dimension: by }), { meter: "browser_time", dimension: by });
  }
  const lines: UsageLine[] = [];
  for (const group of found.values()) {
    const key = keyOf(group);
    const part = onlyRequests(entries, turnOf, (turn) => turnKeys.get(turn) === key);
    const booked = group.meter === "tokens" ? joined([bookedSpend(part, "model"), bookedSpend(part, "decisions")]) : joined([bookedSpend(part, "paid")]);
    // A part whose every request was given back (never sent) used nothing: no line.
    if (booked.requests === 0 && group.meter !== "browser_time") continue;
    // A browser provider whose time no charge booked (none, or each given back) still ran: its seconds with no figure.
    const words = booked.requests === 0 && group.meter === "browser_time" ? ({ usd: null } as CostWords) : costWordsOf(booked.parts);
    const priced = booked.requests - booked.parts.reduce((sum, p) => sum + p.unpriced, 0);
    if (group.meter === "tokens") {
      const { input, output, cacheRead, cacheWrite } = booked.tokens;
      lines.push({ meter: "tokens", dimension: group.dimension, quantity: input + output + cacheRead + cacheWrite, unit: "token", basis: costBasisOf(booked), ...words, requests: booked.requests, tokens: { input, output, cache_read: cacheRead, cache_write: cacheWrite }, unmetered_requests: booked.unmetered });
    } else if (group.meter === "tools") {
      lines.push({ meter: "tools", dimension: group.dimension, quantity: booked.requests, unit: "call", basis: priced > 0 ? "estimate" : "unpriced", ...words });
    } else {
      const s = seconds.get(group.dimension);
      lines.push({ meter: "browser_time", dimension: group.dimension, quantity: s === undefined ? null : Math.round(s * 1e6) / 1e6, unit: "second", basis: priced > 0 ? "estimate" : "unpriced", ...words });
    }
  }
  lines.sort((a, b) => ORDER[a.meter] - ORDER[b.meter] || (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0));
  // The join over the whole booking, never the lines' rounded figures: the same figure cost.usd is.
  const total = costWordsOf([bookedSpend(entries, "model"), bookedSpend(entries, "paid"), bookedSpend(entries, "decisions")]);
  const unknownLine = lines.some((line) => line.usd === null);
  return { lines, total_usd: unknownLine ? null : total.usd };
}

/** Run `runId`'s usage lines (GET /runs/{run_id}/usage); undefined for an unknown run. No lines (`reason`) while it is at
 *  work, for a run whose figure is not its booking's, and for a learning run a follow-up opened again: the cases where
 *  `cost.tools_usd` is null for the same reasons. Its state, launch, learning rounds and journal are read in one snapshot
 *  of the store (one moment): a follow-up that reopens the run between two reads can't put its requests under `final`. */
export async function runUsageOverStore(store: Store, runId: string): Promise<RunUsage | undefined> {
  return store.snapshot(async (snapshot) => {
    const run = await snapshot.runs.get(runId);
    if (!run) return undefined;
    const none = (reason: UsageReason, final: boolean): RunUsage => ({ run_id: runId, final, currency: "USD", total_usd: null, lines: null, reason });
    if (!FINAL_STATES.includes(run.state)) return none("running", false);
    const launch = await launchOf(snapshot, runId);
    if (run.importedFrom || launch?.native || launch?.sdk) return none("not_booked", true);
    if ((await roundsOf(snapshot, runId)).length > 1) return none("reopened", true);
    const records = await journalRecords(snapshot.readJournal(runId), BACKGROUND_CONTEXT);
    if (unbookedCli(records.entries as never)) return none("not_booked", true);
    const turns = reflectRanges(records.submissions ?? [], records.entries);
    const entries = records.entries.filter((entry) => !inReflect(turns, Number(entry.id))) as EntryLike[];
    const { lines, total_usd } = usageLinesOf(entries);
    return { run_id: runId, final: true, currency: "USD", total_usd, lines, reason: null };
  });
}
