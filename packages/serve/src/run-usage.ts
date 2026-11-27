// A run's cost, line by line (GET /runs/{run_id}/usage): what one run used and what it cost, by the model its requests
// went to, by who charged for its paid tool calls, and by the browser provider whose session time it ran up. For the
// person who runs AgentRun and wants to know what a run cost and whose invoice each part lands on; anyone who accounts
// for runs reads the same lines. A quantity is as it was measured (tokens as reported, seconds unrounded), and its dollars
// are the figures the run's booking already holds, the ones `cost.usd` joins: nothing is priced here.
//
// Nothing is measured again. The lines are the run's booking (runner/metrics.ts bookedSpend) split by what each charge
// was: its model requests and its decisions by the model each was sent on (`tokens`), its paid tool calls by who charged
// for them (`tools`, with the calls that ran unpriced beside them; a decision Parallel answered on its own API is one,
// Parallel's, beside its web tools' calls), and its browser session time by its provider
// (`browser_time`, with the seconds its BROWSER_CHARGED records keep). Each part is read by bookedSpend itself, over the
// run's entries with only that part's requests left in, so a line's figure follows the one rule its sum does; and the
// lines join (costWordsOf) to `total`, which is the run's `cost.usd`: the same booking outside its end-of-run (learning)
// turn, as `cost.tools_usd` reads it (store-view.ts toolsUsdOverStore). That turn is the server's own work for the agent,
// not the run's task, and `cost.usd` leaves it out the same way. Unknown is never $0: a line whose charge is unknown says
// so (`usd` null, what is known beside it), and a run the server cannot split says why (`reason`) with no lines.
//
// Beside the lines, each computer the run made (`computer_intervals`, store computer_intervals): its provider's own id,
// what it was made with, when it was made and when its provider's delete answered ok (null while none did). Its time is on
// `compute_time` lines (compute-cost.ts), one per provider and resource (vCPU, memory, a GPU type, disk): the quantity is
// every second of each such computer of the run's at its figure (an open one's up to the read), and `usd` is what the
// run's ledger booked for it while a claim held it, so `total` stays the run's `cost.usd`. Time no claim held (a computer
// kept for a follow-up, one deleted after its run, one whose delete failed) is said apart (`unheld_quantity`) and costs
// nothing on the line or in `total`. A resource with no price is `unpriced`, its `usd` null.
//
// Each line is one attempt's (store run_attempts): a claim that was cut (its runner drained, crashed or lost its lease, or
// its turn was tried again) and whose turn another claim worked again made every request and paid call of it again. Its
// lines say so (`billable: false`, its `attempt` beside it), apart from the attempt that finished the turn, and the run's
// `infra_usd` is their sum: the cost of the infrastructure's own redo, not of the run's task. Data only: `total` and
// `cost.usd` still hold every line, billable or not, as the run was charged before. A run whose claims kept no attempt
// (one made before them) reads each line's `attempt` as null and every line billable.
//
// The time of browsers a create race left running that the run never held (charged under browser-cost.ts unheldTag) is
// a `browser_time` line of its own, `absorbed: "create_race"` and not billable: booked on the run's ledger and in `total`
// and `cost.usd`, so the run's cost record is whole, and in `infra_usd`, the infrastructure's to absorb, never billed.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import { type BrowserSessionLine, browserSessionsOf } from "./browser-sessions.js";
import { BROWSER_CHARGED, browserChargeRef, unheldBrowserTag } from "./cap.js";
import { launchOf } from "./handed-values.js";
import { inReflect, reflectRanges } from "./runner/end-of-run.js";
import { journalRecords } from "./runner/journal-reader.js";
import { KINDS } from "./runner/journal-kinds.js";
import { type BookedSpend, bookedSpend, type CostBasis, costBasisOf, costWordsOf, type CostWords } from "./runner/metrics.js";
import { unbookedCli } from "./store-reads/cap.js";
import { booksDecisions, chargedByParallel, decisionsOverStore, PARALLEL_CHARGER, receiptIdOf } from "./store-reads/decisions.js";
import { MODEL_PROVIDER } from "./model.js";
import type { RunLaunch } from "./run-launch.js";
import { ApiError } from "./errors.js";
import { redacted } from "./key-refusal.js";
import { runCutValues } from "./run-cut.js";
import { type SignInReader, WITHHELD_SIGN_IN } from "./run-view.js";
import { type ComputerIntervalRow, FINAL_STATES, type RunAttemptRow, type Store } from "./store/index.js";
import { COMPUTE_TOOL, COMPUTE_UNITS, type ComputeResource, type ComputeUnit, computeTag, resourcesOf, unmetered } from "./compute-cost.js";
import { type EntryLike, TOOL_UNMETERED } from "./timeline/index.js";

/** The meters a run's lines are on: the contract's `tokens` and `browser_time`, and this server's `tools` and
 *  `compute_time`. */
export type UsageMeter = "tokens" | "tools" | "browser_time" | "compute_time";

/** One line of a run's cost: one model, one charger or one browser provider on a meter. Which it is: `model` and
 *  `provider` on `tokens` (the model the requests were sent on; the provider they went to, named only when the server
 *  sent them there itself, null behind a gateway, whose upstream the server does not know), `charged_by` on `tools` (who
 *  charged for the calls) and `provider` beside it (the same name: the vendor that charges for a call is its provider),
 *  `provider` on `browser_time`; every other one null, and null where the record names none, never "". `quantity` in `unit`: tokens
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
  unit: "token" | "call" | "second" | ComputeUnit;
  basis: CostBasis;
  /** The attempt at its turn the line's requests were made in (1 the first, 2 its first redo, …); null for a run whose
   *  claims kept no attempt. */
  attempt: number | null;
  /** False for an attempt that was cut and whose turn another attempt worked again: its requests were made again, the
   *  infrastructure's cost (the run's `infra_usd`), not the task's; and for an absorbed line (`absorbed`). */
  billable: boolean;
  /** Why the line's cost is the infrastructure's own, absorbed and never billed, though booked on the run's ledger and in
   *  `total`: `create_race`, on `browser_time`, the time of browsers a create race left running that the run never held
   *  (released at its let-go, or by a release by a session's tag beside its own). Absent on every other line. */
  absorbed?: Absorbed;
  /** On `compute_time`: the resource (vcpu, memory, gpu, disk), a GPU's type, the part of `quantity` no claim held (in
   *  no cost), and how many of its computers are still open, their time counted up to `measured_to`. */
  resource?: ComputeResource;
  gpu_type?: string | null;
  unheld_quantity?: number | null;
  open_computers?: number;
  measured_to?: string;
  requests?: number;
  tokens?: { input: number; output: number; cache_read: number; cache_write: number };
  unmetered_requests?: number;
  not_metered_calls?: number;
} & CostWords;

/** Why a line's cost is absorbed (RunUsageLine.absorbed). */
export type Absorbed = "create_race";

/** Why a run has no lines: `running`, it is at work and its booking still moves; `not_booked`, its figure is not its
 *  booking's (an imported run's, a native or SDK run's harness's own, a CLI run whose model requests went past its proxy).
 *  A learning run a follow-up opened again has lines: its job's and its follow-ups' together, up to its latest end. */
export type UsageReason = "running" | "not_booked";

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
  /** One record per browser session the run opened (browser-sessions.ts), for matching `browser_time` to the provider's
   *  own records by its session id; null exactly when `lines` is. */
  browser_sessions: RunBrowserSession[] | null;
  /** One record per computer the run made (computerIntervalsOf), by when each was made; null exactly when `lines` is.
   *  Computer time is not priced: its cost is in no line and not in `total`. */
  computer_intervals: ComputerIntervalLine[] | null;
  /** The sum of the lines that are not billable (`billable: false`): what the infrastructure's redo of cut attempts and
   *  its absorbed lines (`absorbed`) cost. 0 for a run with neither; null with no lines, and when one such line's cost is unknown. Inside
   *  `total`, never beside it. */
  infra_usd: number | null;
  reason: UsageReason | null;
};

/** One computer the run made through its provider (a sandbox, a desktop, a phone), as GET /runs/{run_id}/usage serves
 *  it: the provider (this server's id for it) and the provider's own id for the computer, its kind, what it was made with
 *  (its provider's own figures where it gave them, else what its create asked; null where neither says), when it was made,
 *  when its provider's delete answered ok (`ended_at`, null while none did: still running, or its delete failed or was
 *  never asked), whether the run's park kept it past its claim, and how much of its time a claim of the run booked
 *  (`booked_seconds`; the rest is time no claim held). */
export type ComputerIntervalLine = {
  provider: string;
  provider_id: string;
  kind: string | null;
  gpu: { type: string | null; count: number | null } | null;
  cpus: number | null;
  memory_mb: number | null;
  disk_gb: number | null;
  started_at: string;
  ended_at: string | null;
  kept: boolean;
  booked_seconds: number;
  /** The attempt whose claim made the computer, and whether that attempt is billable (RunUsageLine). */
  attempt: number | null;
  billable: boolean;
};

/** The run's computer rows as served (ComputerIntervalLine), in the order the store reads them (by when each was made). */
export function computerIntervalsOf(rows: readonly ComputerIntervalRow[], attempts: readonly RunAttemptRow[] = []): ComputerIntervalLine[] {
  const tags = attemptTags(attempts);
  return rows.map((row) => ({
    provider: row.provider,
    provider_id: row.providerId,
    kind: row.kind,
    gpu: row.gpuType === null && row.gpuCount === null ? null : { type: row.gpuType, count: row.gpuCount },
    cpus: row.cpus,
    memory_mb: row.memoryMb,
    disk_gb: row.diskGb,
    started_at: new Date(row.startedAt).toISOString(),
    ended_at: row.endedAt === null ? null : new Date(row.endedAt).toISOString(),
    kept: row.kept,
    booked_seconds: row.bookedMs / 1000,
    ...tags.atTime(row.startedAt),
  }));
}

/** Which attempt a part of a run's usage was made in, and whether it is billable. */
export type AttemptTag = { attempt: number | null; billable: boolean };
const NO_ATTEMPT: AttemptTag = { attempt: null, billable: true };

/** A run's attempts (`rows`, by epoch) as tags: the attempt a journal entry was written in (the last claim whose first
 *  entry id is at or below the entry's), and the one a time falls in (the last claim made at or before it, on the
 *  store's clock: a computer is made a moment after its claim). `spans` splits a stretch of time across the claims whose
 *  windows it falls in (each claim's window runs from its claim to the next claim's). Every part is billable: a claim
 *  that takes over a cut turn resumes from what the cut one saved (its answered requests, its finished calls), so that
 *  work is the task's, done once. `redoneAt` is the one exception: the attempt an entry was written in, billable unless
 *  another claim worked its turn again after it (the same turn, one attempt more), for a model request that attempt sent
 *  and never finished (usageLinesOf), which the claim after it sends again. With no rows (a run from before
 *  them), every part is NO_ATTEMPT: attempt null, billable. A part before the first row is NO_ATTEMPT too, unless that
 *  row is the run's first claim (taken from queued): then nothing came before it, and a part read a moment early (a
 *  runner's clock behind the store's) is that claim's. A run that took its first row after the change that writes them
 *  (an older run's follow-up) never counts what it did before as any attempt's. */
export function attemptTags(rows: readonly RunAttemptRow[]): { atEntry(id: unknown): AttemptTag; redoneAt(id: unknown): AttemptTag; atTime(ms: number): AttemptTag; spans(from: number, to: number): { at: AttemptTag; ms: number }[] } {
  const sorted = [...rows].sort((a, b) => a.epoch - b.epoch);
  const tagOf = (row: RunAttemptRow | undefined): AttemptTag => (row === undefined ? NO_ATTEMPT : { attempt: row.attempt, billable: true });
  const redoneOf = (row: RunAttemptRow | undefined): AttemptTag =>
    row === undefined ? NO_ATTEMPT : { attempt: row.attempt, billable: !sorted.some((later) => later.epoch > row.epoch && later.turn === row.turn && later.attempt === row.attempt + 1) };
  const last = (fits: (row: RunAttemptRow) => boolean): RunAttemptRow | undefined => sorted.filter(fits).at(-1);
  const before = sorted[0]?.from === "queued" ? sorted[0] : undefined;
  const entryRow = (id: unknown): RunAttemptRow | undefined => {
    const n = Number(id);
    return Number.isFinite(n) ? last((row) => row.journalFrom <= n) ?? before : sorted.at(-1);
  };
  return {
    atEntry: (id) => tagOf(entryRow(id)),
    redoneAt: (id) => redoneOf(entryRow(id)),
    atTime: (ms) => tagOf(last((row) => row.claimedAt <= ms) ?? before),
    spans: (from, to) => {
      if (!(to > from)) return [{ at: tagOf(last((row) => row.claimedAt <= from) ?? before), ms: 0 }];
      const out: { at: AttemptTag; ms: number }[] = [];
      // The edges of each claim's window, the first one's reaching back to `from` when it is the run's first claim.
      const edges = sorted.map((row, i) => ({ row, start: i === 0 && before ? Number.NEGATIVE_INFINITY : row.claimedAt, end: sorted[i + 1]?.claimedAt ?? Number.POSITIVE_INFINITY }));
      const firstStart = edges[0]?.start ?? Number.POSITIVE_INFINITY;
      if (from < firstStart) out.push({ at: NO_ATTEMPT, ms: Math.min(to, firstStart) - from });
      for (const edge of edges) {
        const ms = Math.min(to, edge.end) - Math.max(from, edge.start);
        if (ms > 0) out.push({ at: tagOf(edge.row), ms });
      }
      return out;
    },
  };
}
const attemptKey = (at: AttemptTag) => `${at.attempt ?? ""}:${at.billable ? 1 : 0}`;

type Group = { meter: UsageMeter; name: string | null; provider?: string | null; tag?: string | null; at: AttemptTag; absorbed?: Absorbed };

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

const ORDER: Record<UsageMeter, number> = { tokens: 0, tools: 1, browser_time: 2, compute_time: 3 };
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
export function usageLinesOf(entries: readonly EntryLike[], launch?: Pick<RunLaunch, "model">, receipts: ReadonlyMap<string, DecisionReceiptLike> = new Map(), computers: { readonly rows: readonly ComputerIntervalRow[]; readonly at: number } = { rows: [], at: 0 }, attempts: readonly RunAttemptRow[] = []): { lines: RunUsageLine[]; total: CostWords } {
  const conversation = (key: string) => entries.find((e) => e.kind === KINDS.sessionKey && (e.data as { key?: unknown } | undefined)?.key === key)?.data as { conversation?: unknown } | undefined;
  const paidConv = Number(conversation(TOOL_SESSION)?.conversation ?? Number.NaN);
  const conv = (e: EntryLike) => Number(e.conversationId);
  const turnOf = (e: EntryLike) => `${String(e.conversationId)}:${String((e.data as { turn?: unknown } | undefined)?.turn)}`;
  // A line is one meter, one name and, on `tokens`, one route: a model reached two ways (the run's own requests behind a
  // gateway, a decision on its provider) is two lines, never one labelled with either's provider.
  const keyOf = (group: Group) => `${group.meter}\u0000${group.name ?? ""}\u0000${group.provider ?? ""}\u0000${group.tag ?? ""}\u0000${attemptKey(group.at)}\u0000${group.absorbed ?? ""}`;
  // A browser a create race left running that the run never held (its charge's tag, browser-cost.ts unheldTag): its time
  // is on a line of its own, booked and in `total`, and not billable (absorbed).
  const browserGroup = (name: string | null, tag: unknown, at: AttemptTag): Group => (unheldBrowserTag(tag) ? { meter: "browser_time", name, at: { ...at, billable: false }, absorbed: "create_race" } : { meter: "browser_time", name, at });
  // Each booked request's attempt: the claim that wrote its first record (its hold, or its booking), never a later
  // claim's settling of it.
  const tags = attemptTags(attempts);
  // A browser charge is the attempt's whose claim wrote it on the root (BROWSER_CHARGED), even when its booking landed
  // under a later claim (browser-cost.ts bookRootCharges books one its process lost): the booking names it by its ref
  // (browserChargeRef, the one rule the booking takes).
  const chargeAt = new Map<string, AttemptTag>();
  for (const e of entries) {
    const d = (e.data ?? {}) as { tag?: unknown; at?: unknown; final?: unknown };
    if (e.kind === BROWSER_CHARGED && typeof d.tag === "string") chargeAt.set(browserChargeRef({ tag: d.tag, at: d.at, final: d.final }), tags.atEntry(e.id));
  }
  // A model request its attempt sent and never finished: no answer booked (a crash cut it off), or booked as cut (a stop
  // cut it, at its hold). The claim that takes the turn over sends it again, so when a later claim redid that turn it is
  // the infrastructure's (redoneAt). An answered request, and every paid call, is the task's: the next claim reuses it.
  const answered = new Set<string>();
  for (const e of entries) {
    if (e.kind === RUNNER_RECORDS.turn && (e.data as { cut?: unknown } | undefined)?.cut !== true) answered.add(turnOf(e));
  }
  const unfinished = (e: EntryLike) => conv(e) !== paidConv && !answered.has(turnOf(e));
  const atOf = new Map<string, AttemptTag>();
  for (const e of entries) {
    if (!(e.kind === RUNNER_RECORDS.request || e.kind === RUNNER_RECORDS.turn) || atOf.has(turnOf(e))) continue;
    const ref = (e.data as { ref?: unknown } | undefined)?.ref;
    atOf.set(turnOf(e), (typeof ref === "string" ? chargeAt.get(ref) : undefined) ?? (unfinished(e) ? tags.redoneAt(e.id) : tags.atEntry(e.id)));
  }
  const at = (e: EntryLike) => atOf.get(turnOf(e)) ?? tags.atEntry(e.id);
  // Each booked request's group, by its turn: a model request's or a decision's, the model its runner.request was sent on;
  // a paid charge's, who charged for it (`charged_by`), on browser_time when it is the browser's session time. A paid
  // charge settled at its provider's own figure says so on its request (`reported`). A decision's request names the
  // decision (`decision:<id>`): its receipt names the model and provider that answered it, and how its cost was reached.
  // A decision Parallel answered on its own API (chargedByParallel) is a paid call Parallel charged at its list price, on
  // Parallel's `tools` line beside its web tools' calls, not a model's tokens: it is on one line, never on both.
  const groups = new Map<string, Group>();
  const reported = new Set<string>();
  const estimated = new Set<string>();
  // A decision's tokens are its receipt's: its booking keeps its cost, with no usage (the cap books it at none).
  const decisionTokens = new Map<string, { input: number; output: number }>();
  for (const e of entries) {
    if (e.kind !== RUNNER_RECORDS.request) continue;
    const d = (e.data ?? {}) as { model?: unknown; tool?: unknown; charged_by?: unknown; reported?: unknown; tag?: unknown };
    // A computer's time (compute-cost.ts) by its provider and resource (its tag); a browser's by its provider.
    if (conv(e) === paidConv) groups.set(turnOf(e), d.tool === COMPUTE_TOOL ? { meter: "compute_time", name: named(d.charged_by), tag: named(d.tag), at: at(e) } : d.tool === "browser" ? browserGroup(named(d.charged_by), d.tag, at(e)) : { meter: "tools", name: named(d.charged_by), at: at(e) });
    else if (named(d.model)?.startsWith("decision:")) {
      const receipt = receipts.get(String(d.model).slice("decision:".length));
      if (receipt && chargedByParallel(receipt)) {
        groups.set(turnOf(e), { meter: "tools", name: PARALLEL_CHARGER, at: at(e) });
        continue;
      }
      // A receipt that names no model leaves `model` null: its provider is said as the provider, never as a model.
      groups.set(turnOf(e), receipt ? { meter: "tokens", name: named(receipt.model), provider: named(receipt.provider), at: at(e) } : { meter: "tokens", name: null, provider: null, at: at(e) });
      if (receipt?.cost_basis === "reported") reported.add(turnOf(e));
      else if (receipt?.cost_basis === "estimate") estimated.add(turnOf(e));
      const usage = (receipt?.usage ?? undefined) as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
      const tokenCount = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
      const [input, output] = [tokenCount(usage?.input_tokens), tokenCount(usage?.output_tokens)];
      if (input !== undefined && output !== undefined) decisionTokens.set(turnOf(e), { input, output });
    } else groups.set(turnOf(e), { meter: "tokens", name: named(d.model), provider: upstreamOf(named(d.model), launch), at: at(e) });
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
    const group = groups.get(turnOf(e)) ?? (conv(e) === paidConv ? { meter: "tools" as const, name: null, at: at(e) } : { meter: "tokens" as const, name: null, provider: null, at: at(e) });
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
    const d = (e.data ?? {}) as { tool?: unknown; seconds?: unknown; charged_by?: unknown; tag?: unknown };
    if (e.kind === TOOL_UNMETERED) {
      const group: Group = { meter: "tools", name: named(d.charged_by), at: tags.atEntry(e.id) };
      unpricedCalls.set(keyOf(group), (unpricedCalls.get(keyOf(group)) ?? 0) + 1);
      if (!found.has(keyOf(group))) found.set(keyOf(group), group);
      continue;
    }
    if (e.kind !== BROWSER_CHARGED || d.tool !== "browser" || typeof d.seconds !== "number" || !Number.isFinite(d.seconds)) continue;
    const group = browserGroup(named(d.charged_by), d.tag, tags.atEntry(e.id));
    seconds.set(keyOf(group), (seconds.get(keyOf(group)) ?? 0) + d.seconds);
    if (!found.has(keyOf(group))) found.set(keyOf(group), group);
  }
  const lines: RunUsageLine[] = [];
  /** What the ledger booked for each computer provider and resource (computeLinesOf), by its line's key. */
  const computeBooked = new Map<string, { booked: ReturnType<typeof joined>; at: AttemptTag }>();
  for (const group of found.values()) {
    const key = keyOf(group);
    const part = onlyRequests(entries, turnOf, (turn) => turnKeys.get(turn) === key);
    // A `tools` line's part holds its charger's paid calls and, on Parallel's, the decisions Parallel charged.
    const booked = joined(group.meter === "tokens" ? [bookedSpend(part, "model"), bookedSpend(part, "decisions")] : group.meter === "tools" ? [bookedSpend(part, "paid"), bookedSpend(part, "decisions")] : [bookedSpend(part, "paid")]);
    if (group.meter === "compute_time") {
      // A hold for a stretch names no resource (no tag) and books nothing: it is given back.
      if (group.tag !== null && group.tag !== undefined) computeBooked.set(computeKey(group.name ?? "", group.tag, group.at), { booked, at: group.at });
      continue;
    }
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
      lines.push({ meter: "tokens", model: group.name, provider: group.provider ?? null, charged_by: null, quantity: input + output + cacheRead + cacheWrite, unit: "token", basis: costBasisOf({ priced }), ...group.at, ...costWordsOf(booked.parts), requests: booked.requests, tokens: { input, output, cache_read: cacheRead, cache_write: cacheWrite }, unmetered_requests: unmetered });
    } else if (group.meter === "tools") {
      // `reported` when every charge with a figure was settled at its provider's own (monid's answer says what it
      // charged); `estimate` when any was settled at a price this server holds (an MCP tool's owner's, Parallel's, a
      // Parallel decision's list price).
      const basis = priced <= 0 ? "unpriced" : turns.every((turn) => reported.has(turn)) ? "reported" : "estimate";
      // Calls that ran unpriced only: none booked, so nothing is charged on the line, by its owner's choice of no price.
      const words: CostWords = booked.requests === 0 ? { usd: 0 } : costWordsOf(booked.parts);
      lines.push({ meter: "tools", model: null, provider: group.name, charged_by: group.name, quantity: booked.requests, unit: "call", basis, ...group.at, ...words, ...(notMetered ? { not_metered_calls: notMetered } : {}) });
    } else {
      const s = seconds.get(key);
      // A browser's holds given back with no time charged (a call that held and used nothing, a provider priced at $0 with
      // no charge record) used nothing: no line.
      if (booked.requests === 0 && s === undefined) continue;
      // A browser provider whose time no charge booked (none, or each given back) still ran: its seconds with no figure.
      const words: CostWords = booked.requests === 0 ? { usd: null } : costWordsOf(booked.parts);
      lines.push({ meter: "browser_time", model: null, provider: group.name, charged_by: null, quantity: s === undefined ? null : Math.round(s * 1e6) / 1e6, unit: "second", basis: priced > 0 ? "estimate" : "unpriced", ...group.at, ...(group.absorbed ? { absorbed: group.absorbed } : {}), ...words });
    }
  }
  lines.push(...computeLinesOf(computers.rows, computers.at, computeBooked, tags.spans));
  // Each meter by its name (a model, a charger, a browser provider; none first), `tokens` then by its route's provider,
  // `compute_time` then by its resource in compute-cost.ts's order and a GPU's type.
  const sortKey = (line: RunUsageLine) =>
    line.meter === "tokens"
      ? `${line.model ?? ""}\u0000${line.provider ?? ""}`
      : line.meter === "tools"
        ? line.charged_by ?? ""
        : line.meter === "compute_time"
          ? `${line.provider ?? ""}\u0000${RESOURCE_ORDER[line.resource ?? "vcpu"]}\u0000${line.gpu_type ?? ""}`
          : line.provider ?? "";
  // Then by attempt, a line of no attempt first, and a cut attempt's before the billable one of the same number.
  const attemptOrder = (line: RunUsageLine) => (line.attempt ?? 0) * 2 + (line.billable ? 1 : 0);
  lines.sort((a, b) => ORDER[a.meter] - ORDER[b.meter] || (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0) || attemptOrder(a) - attemptOrder(b));
  // The join over the whole booking, never the lines' rounded figures: the same figure cost.usd is. A browser line whose
  // time no charge booked is unknown beside it: the total is too, with the booking's figure as what is known.
  const total = costWordsOf([bookedSpend(entries, "model"), bookedSpend(entries, "paid"), bookedSpend(entries, "decisions")]);
  const unbooked = lines.filter((line) => line.usd === null && line.meter === "browser_time" && line.so_far_usd === undefined).length;
  if (!unbooked) return { lines, total };
  const known = total.usd ?? total.so_far_usd ?? 0;
  return { lines, total: { usd: null, so_far_usd: known, unpriced: (total.usd === null ? (total.unpriced ?? 0) : 0) + unbooked } };
}

/** A compute line's key: its provider, its resource's tag (computeTag) and its attempt. */
const computeKey = (provider: string, tag: string, at: AttemptTag) => `${provider}\u0000${tag}\u0000${attemptKey(at)}`;
const RESOURCE_ORDER: Record<ComputeResource, number> = { vcpu: 0, memory: 1, gpu: 2, disk: 3 };
/** Up to the millionth, as the browser's seconds are. */
const micro = (value: number) => Math.round(value * 1e6) / 1e6;

/** The run's `compute_time` lines: one per provider and resource of the computers it made (`rows`), each second of each at
 *  its figure, an open one's up to `at` (the read), and the part no claim held (its life less its booked time) apart in
 *  `unheld_quantity` (0 for a provider that bills nothing: none of its time costs anything, booked or not, so none is
 *  outside the run's cost). Its money is what the run's ledger booked for it (`booked`, by computeKey): `estimate` when any was;
 *  $0 for a provider that bills nothing; else `unpriced`, its usd null. A figure no one said makes its quantity null. */
function computeLinesOf(rows: readonly ComputerIntervalRow[], at: number, booked: ReadonlyMap<string, { booked: ReturnType<typeof joined>; at: AttemptTag }>, spans: (from: number, to: number) => { at: AttemptTag; ms: number }[]): RunUsageLine[] {
  type Sum = { provider: string; resource: ComputeResource; gpuType: string | null; quantity: number | null; unheld: number | null; open: number; at: AttemptTag };
  const sums = new Map<string, Sum>();
  for (const row of rows) {
    const end = row.endedAt ?? at;
    const livedS = Math.max(0, end - row.startedAt) / 1000;
    const unheldS = Math.max(0, livedS - row.bookedMs / 1000);
    // Its time is the claims' that held it, by each claim's window (a computer kept across a park is billed by the claim
    // that resumed it), so each stretch sits with the attempt whose bookings paid for it. The part no claim held is kept
    // per computer alone: it is spread over the windows by their share of its life.
    const pieces = spans(row.startedAt, end);
    for (const span of pieces) {
      const share = livedS > 0 ? span.ms / 1000 / livedS : 1;
      for (const one of resourcesOf(row)) {
        const key = computeKey(row.provider, computeTag(one), span.at);
        const sum = sums.get(key) ?? { provider: row.provider, resource: one.resource, gpuType: one.gpuType, quantity: 0, unheld: 0, open: 0, at: span.at };
        sum.quantity = sum.quantity === null || one.perSecond === null ? null : sum.quantity + one.perSecond * (span.ms / 1000);
        sum.unheld = sum.unheld === null || one.perSecond === null ? null : sum.unheld + one.perSecond * unheldS * share;
        // An open computer counts once, on the line of the window it is in now.
        if (row.endedAt === null && span === pieces.at(-1)) sum.open += 1;
        sums.set(key, sum);
      }
    }
  }
  // A booking whose computer has no row here (one made before this server kept them): its money, with no quantity.
  for (const [key, one] of booked) {
    if (sums.has(key)) continue;
    const [provider = "", tag = ""] = key.split("\u0000");
    const gpu = tag.startsWith("gpu:");
    const resource = (gpu ? "gpu" : tag) as ComputeResource;
    if (!Object.hasOwn(COMPUTE_UNITS, resource)) continue;
    sums.set(key, { provider, resource, gpuType: gpu ? tag.slice("gpu:".length) : null, quantity: null, unheld: null, open: 0, at: one.at });
  }
  return [...sums.entries()].map(([key, sum]): RunUsageLine => {
    const spend = booked.get(key)?.booked;
    const charged = spend !== undefined && spend.requests > 0;
    const free = !charged && unmetered(sum.provider);
    const words: CostWords = charged ? costWordsOf(spend.parts) : free ? { usd: 0 } : { usd: null };
    return {
      meter: "compute_time", model: null, provider: sum.provider, charged_by: sum.provider,
      quantity: sum.quantity === null ? null : micro(sum.quantity), unit: COMPUTE_UNITS[sum.resource], basis: charged || free ? "estimate" : "unpriced", ...sum.at, ...words,
      resource: sum.resource, gpu_type: sum.gpuType, unheld_quantity: unmetered(sum.provider) ? 0 : sum.unheld === null ? null : micro(sum.unheld), open_computers: sum.open,
      ...(sum.open > 0 ? { measured_to: new Date(at).toISOString() } : {}),
    };
  });
}

/** The run's own browser sessions: those its job opened or charged (`job`, the journal less the end-of-run learning
 *  turn), each with its end read from the whole journal (`all`). The run's end lets its browsers go inside the learning
 *  turn's range (reflectRanges runs to the run's end), so an end read from `job` alone would be missing for a session
 *  released there. A session the learning turn opened is not the job's, as its cost is not. */
function jobSessions(job: readonly EntryLike[], all: readonly EntryLike[], attempts: readonly RunAttemptRow[] = []): RunBrowserSession[] {
  const ends = new Map(browserSessionsOf(all).map((one) => [one.tag, one]));
  // A session is the attempt's whose claim first wrote of it (its open, else its first charge).
  const tags = attemptTags(attempts);
  const first = new Map<string, AttemptTag>();
  for (const e of job) {
    const tag = (e.data as { tag?: unknown } | undefined)?.tag;
    if (typeof tag === "string" && !first.has(tag)) first.set(tag, tags.atEntry(e.id));
  }
  return browserSessionsOf(job).map((one) => {
    const at = first.get(one.tag) ?? NO_ATTEMPT;
    const whole = ends.get(one.tag);
    if (one.ended_at !== null || !whole || whole.ended_at === null) return { ...one, ...at };
    const { provider_session_id, started_at, ended_at, release_reason, provider_record, provider_record_status } = whole;
    return { ...one, provider: one.provider || whole.provider, provider_session_id, started_at, ended_at, release_reason, provider_record, provider_record_status, ...at };
  });
}

/** A browser session as the usage read serves it: its record (BrowserSessionLine), and the attempt whose claim opened it
 *  and whether that attempt is billable (RunUsageLine). */
export type RunBrowserSession = BrowserSessionLine & AttemptTag;

/** Whether `entries` hold any absorbed time: a charge, or a paid step, of a browser a create race left running that the
 *  run never held (its tag, cap.ts unheldBrowserTag). Most runs hold none, so their readers skip the line rule below. */
export function holdsAbsorbed(entries: readonly EntryLike[]): boolean {
  return entries.some((e) => (e.kind === BROWSER_CHARGED || e.kind === RUNNER_RECORDS.request) && unheldBrowserTag((e.data as { tag?: unknown } | undefined)?.tag));
}

/** `entries` less the paid-tools session's requests and bookings of absorbed time (the turns whose request is a browser
 *  charge under an unheld tag, the ones usageLinesOf puts on an `absorbed` line), so bookedSpend over them counts every
 *  paid charge but those. */
export function withoutAbsorbed(entries: readonly EntryLike[]): EntryLike[] {
  const paid = entries.find((e) => e.kind === KINDS.sessionKey && (e.data as { key?: unknown } | undefined)?.key === TOOL_SESSION)?.data as { conversation?: unknown } | undefined;
  const paidConv = Number(paid?.conversation ?? Number.NaN);
  const turnOf = (e: EntryLike) => `${String(e.conversationId)}:${String((e.data as { turn?: unknown } | undefined)?.turn)}`;
  const absorbed = new Set<string>();
  for (const e of entries) {
    const d = (e.data ?? {}) as { tool?: unknown; tag?: unknown };
    if (e.kind === RUNNER_RECORDS.request && Number(e.conversationId) === paidConv && d.tool === "browser" && unheldBrowserTag(d.tag)) absorbed.add(turnOf(e));
  }
  if (absorbed.size === 0) return [...entries];
  return entries.filter((e) => !((e.kind === RUNNER_RECORDS.request || e.kind === RUNNER_RECORDS.turn) && absorbed.has(turnOf(e))));
}

/** What the absorbed lines of a run whose journal is `entries` cost, the run read's absorbed part of `usd`
 *  (`cost.billable_usd` is `usd` less this): the sum of its `absorbed` lines' `usd` as GET /runs/{run_id}/usage serves
 *  them (usageLinesOf, the one line rule, over its claims' `attempts`), 0 with none, null when one of them has no known
 *  figure. */
export function absorbedUsdOf(entries: readonly EntryLike[], attempts: readonly RunAttemptRow[]): number | null {
  if (!holdsAbsorbed(entries)) return 0;
  let sum = 0;
  for (const line of usageLinesOf(entries, undefined, new Map(), { rows: [], at: 0 }, attempts).lines) {
    if (!line.absorbed) continue;
    if (line.usd === null) return null;
    sum += line.usd;
  }
  return Math.round(sum * 1e12) / 1e12;
}

/** The sum of the lines no customer is charged for (`billable: false`): null when one of them has no known figure. */
export function infraUsdOf(lines: readonly RunUsageLine[]): number | null {
  let sum = 0;
  for (const line of lines) {
    if (line.billable) continue;
    if (line.usd === null) return null;
    sum += line.usd;
  }
  return Math.round(sum * 1e12) / 1e12;
}

/** Run `runId`'s usage lines (GET /runs/{run_id}/usage); undefined for an unknown run. No lines (`reason`) while it is at
 *  work and for a run whose figure is not its booking's: the cases where `cost.tools_usd` is null for the same reasons. A
 *  learning run a follow-up opened again reads every round's job and follow-up turns, each round's end-of-run turn left
 *  out (reflectRanges), so each end's lines hold the last end's and what the follow-up added. Its state, launch, learning rounds and journal are read in one snapshot
 *  of the store (one moment): a follow-up that reopens the run between two reads can't put its requests under its end. */
export async function runUsageOverStore(store: Store, runId: string): Promise<RunUsage | undefined> {
  return store.snapshot(async (snapshot) => {
    const run = await snapshot.runs.get(runId);
    if (!run) return undefined;
    const ended = FINAL_STATES.includes(run.state) && run.endedAt !== null ? new Date(run.endedAt).toISOString() : null;
    const none = (reason: UsageReason): RunUsage => ({ run_id: runId, ended_at: reason === "running" ? null : ended, currency: "USD", total: null, lines: null, browser_sessions: null, computer_intervals: null, infra_usd: null, reason });
    if (!FINAL_STATES.includes(run.state)) return none("running");
    const launch = await launchOf(snapshot, runId);
    if (run.importedFrom || launch?.native || launch?.sdk) return none("not_booked");
    const records = await journalRecords(snapshot.readJournal(runId), BACKGROUND_CONTEXT);
    if (unbookedCli(records.entries as never)) return none("not_booked");
    const turns = reflectRanges(records.submissions ?? [], records.entries);
    const entries = records.entries.filter((entry) => !inReflect(turns, Number(entry.id))) as EntryLike[];
    // A workflow's decision receipts, read only when it made a decision: the model and provider each was answered on.
    const receipts = booksDecisions(entries) ? new Map((await decisionsOverStore(snapshot, runId, BACKGROUND_CONTEXT)).map((receipt) => [receiptIdOf(receipt), receipt])) : undefined;
    // Its computers in the same snapshot, an open one's time counted up to now; a store that keeps none (a test's) reads
    // as none made.
    const rows = snapshot.computerIntervals ? await snapshot.computerIntervals.forRun(runId) : [];
    // Its claims' attempts in the same snapshot; a store that keeps none (a test's) reads as a run of no attempts.
    const attempts = snapshot.runAttempts ? await snapshot.runAttempts.forRun(runId) : [];
    const { lines, total } = usageLinesOf(entries, launch, receipts, { rows, at: Date.now() }, attempts);
    const computers = computerIntervalsOf(rows, attempts);
    return { run_id: runId, ended_at: ended, currency: "USD", total, lines, browser_sessions: jobSessions(entries, records.entries as unknown as readonly EntryLike[], attempts), computer_intervals: computers, infra_usd: infraUsdOf(lines), reason: null };
  });
}

/** Run `runId`'s usage lines as served: each name taken from its record (a model, its provider, a tool's charger) through
 *  the run's cut, as its trace serves a model's name, since a decision provider or a tool names itself in what it
 *  returns. A run withheld (its sign-in can't be read back here) is refused (403), as its trace is. */
export async function servedRunUsage(deps: { serverSecrets: () => string[]; signIns?: SignInReader; sealKey: Buffer | undefined }, store: Store, runId: string): Promise<RunUsage | undefined> {
  if ((await runCutValues(deps, store, runId)) === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const usage = await runUsageOverStore(store, runId);
  // The cut after the read: it only grows, so it holds every value the read could have seen.
  const cut = await runCutValues(deps, store, runId);
  if (cut === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  if (!usage?.lines) return usage;
  const said = (text: string | null) => (text === null ? null : redacted(text, cut.values));
  // A browser session's words too, every one its records keep: its provider names it, and the provider's record says the rest.
  const session = (one: RunBrowserSession): RunBrowserSession => ({
    ...one,
    provider: redacted(one.provider, cut.values),
    tag: redacted(one.tag, cut.values),
    provider_session_id: said(one.provider_session_id),
    started_at: said(one.started_at),
    ended_at: said(one.ended_at),
    release_reason: said(one.release_reason),
    provider_record: one.provider_record && { ...one.provider_record, started_at: said(one.provider_record.started_at), ended_at: said(one.provider_record.ended_at) },
  });
  return {
    ...usage,
    lines: usage.lines.map((line) => ({ ...line, model: said(line.model), provider: said(line.provider), charged_by: said(line.charged_by), ...(line.gpu_type === undefined ? {} : { gpu_type: said(line.gpu_type) }) })),
    browser_sessions: usage.browser_sessions && usage.browser_sessions.map(session),
    // A computer's words too: its provider's id for it is the provider's, which a run's own tools can name.
    computer_intervals: usage.computer_intervals && usage.computer_intervals.map((one) => ({
      ...one,
      provider: redacted(one.provider, cut.values),
      provider_id: redacted(one.provider_id, cut.values),
      kind: said(one.kind),
      gpu: one.gpu && { ...one.gpu, type: said(one.gpu.type) },
    })),
  };
}
