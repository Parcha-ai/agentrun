// A DSL node on any harness: createHarnessRunner turns an AgentAdapter into exactly the interpreter's `runNode`, so a
// DSL host and serve run a node on a harness adapter (Codex first) the way createPiRunner runs it on Pi. The
// node's record arrives through an injected `submit` tool whose input is the node's schema under `value`
// (submitParameters, the envelope both runners use); a review that does not accept it is the tool's result, in the
// same session. Every paid request passes the runner first: the turn cap, then the host's `beforeRequest` (its budget),
// each of which may refuse it. Under recovery a session is keyed by its step's sessionId: a delivered record is answered
// from the session's records, and a session cut off inside a turn is resumed by the adapter, spending nothing again.
import { randomUUID } from "node:crypto";
import { Compile } from "typebox/compile";
import { submitParameters } from "@parcha/agentrun-dsl";
import { HarnessRunError, SessionFenced, TurnParked } from "./errors.js";
import { bookRequest, type Ended } from "./booking.js";
import type { AdapterEvent, AgentAdapter, CapCut, HarnessEvent, HostTool, JsonValue, ModelPort, ModelRequest, ModelTicket, ModelUsage, NodeRequest, NoteRequest, SessionRecord, SessionSpec, SessionStore, SessionWriter } from "./types.js";

/** Exactly the interpreter's `runNode`, plus `stop`: a pause of every node it is running. With `drainMs`, each node
 *  starts no new turn, call or paid request, its calls in flight run on until their outcomes are recorded (for at most
 *  `drainMs`, on an adapter that can drain), and then it stops, failing `aborted`; its session resumes from its records
 *  when the node runs again. A node started after `stop` fails `aborted` at once. Resolves once every node has stopped. */
export type HarnessRunner = ((request: NodeRequest) => Promise<unknown>) & { stop(options?: { drainMs?: number }): Promise<void> };

/** The tool the runner injects; a host tool may not take its name. */
export const SUBMIT_TOOL = "submit";
/** Why a review rejected a candidate, as the model reads it: its message, or, for none (no message, or a blank one),
 *  that it gave no reason. Always a string, so a rejection never lets the candidate through (Pi's runner reads a review
 *  the same way). A long one reaches the model through the host's one bound on a result (HOST_RESULT_MAX_CHARS). */
const reviewRejection = (message: unknown): string => {
  const said = message === undefined || message === null ? "" : String(message);
  return said.trim() ? said : "the review rejected it without saying why";
};
/** A held figure as a host gives it or a record keeps it: a finite amount, 0 or more, else none. */
const heldFigure = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
/** `total` with `cost` added: unknown once either is. */
const spent = (total: number | null, cost: number | undefined): number | null => (total === null || cost === undefined ? null : total + cost);

/** The records the runner keeps beside the adapter's own, in each session. */
/** `request` is written before a paid request leaves, `turn` when it has answered with its usage: a request a crash cut off
 *  keeps its `request` and has no `turn`. */
export const RUNNER_RECORDS = { request: "runner.request", response: "runner.response", turn: "runner.turn", submit: "runner.submit", accepted: "runner.accepted" } as const;

/** What the host is asked before each paid request. A `refuse` ends the node, final. A `holdUsd` (a finite amount, 0
 *  or more) is what the host holds for the request, what its cap admitted it at: written on the request's record before it
 *  leaves, it is what the request counts at in the spend the host is shown when the request's own cost never comes in
 *  (a response cut short, booked at an unknown cost, or a request a crash cut off, read by a later process). Without
 *  one, such a request leaves the spend unknown. The cost booked for the request is unknown either way. */
export type BeforeRequest = (request: {
  key: string; label: string; executionPath?: string; model: string;
  /** The turn this request would be, counting from 1; `maxTurns` is the node's limit. */
  turn: number; maxTurns: number | null;
  /** The node's `budget_usd`, if it set one, and what its session has spent so far: a request whose cost is unknown at
   *  the figure its host held for it (`holdUsd`), and null when one has no such figure. */
  budgetUsd?: number; spentUsd: number | null;
  /** The most input tokens this request can be billed for (the body's UTF-8 bytes plus what the provider adds, as the
   *  model proxy measured it), undefined when it was not measured: a budget treats that input as unknown, never 0. */
  inputTokensMax?: number;
  /** The most output tokens it asks for, and the least it may be limited to and still answer, as the model proxy read
   *  them from its body (ModelRequest). */
  outputTokensAsked?: number;
  outputTokensLeast?: number;
  /** What it charges beside its tokens (ModelRequest.feeUsd), held with them. */
  feeUsd?: number;
  /** A paid tool call, no model request (ModelRequest.paid): held at its fee alone, named so in a refusal. `call`: the
   *  tool call it was booked under, `charged_by`, who charges for it, and `tool`/`tag`, the tool it is and its session,
   *  all written on its runner.request. `owed`: money already owed at its provider, held and booked, never refused.
   *  `hold`: a hold-only step, given back on a lost claim; `ref`: the one booking it names; `under`: the model session
   *  whose tool call it runs in, whose requests in flight it never waits on (ModelRequest.paid). */
  paid?: { name: string; basis: string; call?: string; charged_by?: string; tool?: string; tag?: string; owed?: true; hold?: true; ref?: string; under?: string };
  /** A side call (ModelRequest.side): on another model than the session's (a client's), or the host's own (`host`). */
  side?: true;
  /** A request on the session's model that is no answer of the turn (ModelRequest.unanswered: a title, a summary, a
   *  child's): still the run's own to book, but no answer the host keeps its wrap-up's reserve back for. */
  unanswered?: true;
  /** It carries the host's note (ModelRequest.noted), and its input measured without it (`inputTokensMaxWithoutNote`):
   *  a host that admits it only without the note says so (Admission.withoutNote). */
  noted?: true;
  inputTokensMaxWithoutNote?: number;
  /** The label of a request the host sent beside the harness's own (ModelRequest.host): a learned workflow's model node,
   *  under the same check as the harness's own. */
  host?: string;
  /** The route it came by (ModelRequest.route), absent for the session's own: the host prices it by model and route. */
  route?: string;
  /** This session's paid requests admitted and not yet answered (in this process), oldest first, each with its own
   *  `inputTokensMax`, the output limit it was admitted with (`outputTokensMax`) and what its host held for it
   *  (`holdUsd`): a budget holds each one until it answers, since `spentUsd` counts answered requests only. Requests are
   *  admitted one at a time, so each check sees every request admitted before it. */
  inFlight: readonly InFlight[];
  /** The run's requests on free models so far (runBooking, over every session of the run): each whose runner.request says
   *  so (`freeRequest`), answered, in flight or cut, and each admitted that no record shows yet. Absent: not counted here. */
  freeRequestsMade?: number;
  /** The run's requests on local models so far, counted the same way (`localRequest`): free, never under the server's
   *  limit, but under the agent's own (RunCapOptions.maxRequests) beside freeRequestsMade. Absent: not counted here. */
  localRequestsMade?: number;
  /** The request's client's signal (ModelRequest.signal): a host that makes it wait for room lets it go when it aborts. */
  signal?: AbortSignal;
  /** The booking's own stop or pause, now (its `stopped`, `draining`, or a cost it could not record): a request waiting
   *  for room leaves with this error once there is one, nothing written for it. */
  halted?: () => Error | undefined;
}) => void | Refusal | Admitted | Promise<void | Refusal | Admitted>;

/** A host's refusal of a request: its words, and, from a spend cap, whether no raise could send it (`forGood`) and, for
 *  one a raise could, its figures (what the run had spent, never a hold; what its steps in flight held; what the request
 *  needs at the least; the least cap that sends it): what the run's end is decided from (the kernel cap's parkOf).
 *  `waits`: refused only because steps still in flight hold the room it needs, steps that settle on their own (it fits
 *  beside the run's spend with none of them out): a booking that can wait (runBooking) asks again once they settle, and
 *  any other reads it as the refusal it is. */
export type Refusal = { refuse: string; forGood?: boolean; figures?: { spentUsd: number; heldUsd?: number; needsUsd: number; leastCapUsd: number; step?: { name: string; holdUsd: number; basis: string } };
  /** The refusal's code, from a host that gives one (a spend cap's: `spend_cap_reached`): carried on the error that ends
   *  the node (HarnessRunError.refusal), so a reader knows the refusal by it, never by its words. */
  code?: string;
  waits?: true };

/** A request admitted and not yet answered, as a budget holds it: at what its host held for it (`holdUsd`), when it held
 *  one. `stays`: a hold-only step (ModelRequest.paid.hold, a browser session's reserve), let go only when its holder says,
 *  never by settling on its own: no request waits for it. */
export type InFlight = { turn: number; model: string; inputTokensMax?: number; outputTokensMax?: number; holdUsd?: number; host?: string; route?: string; freeRequest?: true; localRequest?: true; stays?: true };
/** A host's admission: what it holds for the request (`holdUsd`), and the most output tokens, thinking included, it may
 *  be sent with (`outputTokensMax`, what is left of a cap can buy), which its ticket carries to the model proxy. A
 *  request its client stops part way (`ModelUsage.stoppedAfterBytes`), its cost unknown, counts at `stoppedUsd` of what
 *  streamed, in tokens (one a byte), never more than `holdUsd`; without it, at `holdUsd`. `withoutNote`: a request that
 *  carries its host's note is admitted only as it was without it (the note's bytes did not fit): it goes without it.
 *  `note`: the host's record of the note this request carries, written on the request's `runner.turn` record once it
 *  ends, beside how it was booked, so a later process reads whether the note reached an answer. `freeRequest`: one of
 *  the run's requests on a free model, which its ceiling on such requests counts: written on its runner.request (as
 *  `freeRequest`), so the count holds it in every process, and a cut one books at $0 (bookCut). `localRequest`: one on a
 *  local model (CapModel.local), counted apart (`localRequest` on its runner.request) for the agent's own limit. `capCut`: its output
 *  limited below what it asked by what is left of the cap, the figures an answer cut at that limit says (ModelTicket). */
export type Admission = { holdUsd?: number; outputTokensMax?: number; stoppedUsd?: (streamedTokens: number) => number; withoutNote?: true; note?: { [key: string]: JsonValue }; freeRequest?: true; localRequest?: true; capCut?: CapCut };

/** An admission as a host gives it: with `free` when the request is on a free model (its known price is $0 for every
 *  token, with no fee beside), so it costs nothing however it ends: booked a known $0 (booking.ts), its own cost 0, its
 *  runner.turn marked `free` for a reader to say why. `plan`: the request is billed to a person's subscription plan (a
 *  ChatGPT plan's model, CapModel.plan), never in dollars: it costs the run $0 however it ends, its runner.request and
 *  runner.turn marked so (`plan`, `billing: "plan"`), so a later process books it so too when a crash cut it. */
export type Admitted = Admission & { free?: true; plan?: true };
export interface HarnessRunnerOptions {
  /** The run's store, through whoever owns it. */
  store: SessionStore;
  /** The tools a node may name. A node that names none gets all of them; `tools: []` gets none. */
  tools?: HostTool[];
  /** The most turns (paid model requests) a node gets per attempt (default 8; null for no limit). A node's own
   *  `max_turns` applies within it; one that asks for more is refused, final. */
  maxTurns?: number | null;
  /** The most turns sent to a node per attempt when its turn limit is null (default 100). With a limit, sends are
   *  bounded by it instead. */
  maxSends?: number;
  /** The most `submit` calls a node gets per attempt (default 5; null for no limit). */
  maxSubmissions?: number | null;
  /** Each call's limit in milliseconds (default 120 s; null for none). */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  /** The host's check before each paid request: its budget, `max_cost_usd`. */
  beforeRequest?: BeforeRequest;
  /** Every event, with the node it belongs to. A `request_start` handler's promise is awaited before the request leaves. */
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  /** The private directory of a session, when the adapter needs one. */
  sessionDir?: (key: string) => string;
}

const positive = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

/** Turns in a row that may end with no paid request and no accepted submission before a node ends `no_progress`. The
 *  turn limit counts paid requests only, so without this bound a harness whose turns never reach its model (a cached or
 *  refused answer, a misconfigured model) would be sent turns forever, on microtasks no timer can interrupt. */
export const NO_PROGRESS_TURNS = 3;

/** A request whose answer billed more input than the bound its hold was priced on (InFlight.inputTokensMax): the cap's
 *  one failure that matters, a hold too small. Its model; that bound and what it billed (input, cache reads and cache
 *  writes together, as `inputAfter` reads a bill), in tokens; what was held for it and, when its answer was priced, what
 *  it billed, in USD. */
export type HoldShort = { model: string; boundTokens: number; billedTokens: number; heldUsd: number; billedUsd?: number };

/** What a paid request tells a host, beside its session's key and label. A `request_end` carries how its path saw the
 *  request end (`ended`, booking.ts), when the path said, and `holdShort` when it billed past its hold's bound. */
export type ModelPortEvent = { type: "request_start"; turn: number; model: string; host?: string } | { type: "request_end"; turn: number; usage: ModelUsage; host?: string; ended?: Ended; holdShort?: HoldShort };

/** `usage` against the bound its request's hold was priced on (`flight`'s inputTokensMax; `hold`, what was held): a
 *  HoldShort when it billed more input than that bound. Undefined when it billed at or under it, or when there is nothing
 *  to compare: no bound, no hold (no cap priced it), a request held at $0 whatever its input (billed to a plan or on a
 *  free model, `unpriced`), or a usage with no input count (one cut, or one whose answer reported none). */
const holdShortOf = (usage: ModelUsage, flight: InFlight | undefined, hold: number | undefined, unpriced: boolean): HoldShort | undefined => {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  const input = count(usage.input);
  const bound = count(flight?.inputTokensMax);
  if (!flight || bound === undefined || hold === undefined || unpriced || usage.billing === "plan" || usage.cut || usage.givenBack || input === undefined) return undefined;
  const billed = input + (count(usage.cacheRead) ?? 0) + (count(usage.cacheWrite) ?? 0);
  if (billed <= bound) return undefined;
  return { model: flight.model, boundTokens: bound, billedTokens: billed, heldUsd: hold, ...(typeof usage.usd === "number" && Number.isFinite(usage.usd) ? { billedUsd: usage.usd } : {}) };
};

export interface ModelPortOptions {
  /** The session's key: what `beforeRequest` and every event carry. */
  key: string;
  label?: string;
  executionPath?: string;
  /** The most paid requests (turns) the session may make in this attempt; null (the default) for no limit. */
  maxTurns?: number | null;
  budgetUsd?: number;
  /** Asked before every paid request; a `refuse` ends the attempt. */
  beforeRequest?: BeforeRequest;
  /** Every event. For `request_start` its promise is awaited before the request leaves, and a rejection refuses it: a
   *  host's start mark, made durable there, is never behind a request that was sent. */
  onEvent?: (event: ModelPortEvent & { key: string; label: string; executionPath?: string }) => void | Promise<void>;
  /** The session's records, as already read (default: read from the writer). */
  records?: readonly SessionRecord[];
  /** Provider-qualified names to record on requests sent through the host's model routes. */
  modelNamesByRoute?: ReadonlyMap<string, string>;
  /** How a record is written (default: the writer's append, which a newer open fences). */
  append?: (records: SessionRecord[]) => Promise<void>;
  /** The attempt has stopped: the error a new paid request is refused with. Told the request's host label, for a host
   *  that admits its own requests (ModelRequest.host) while the harness's own are held. A `TurnParked` refuses new
   *  requests but is no stop of the booking: a paid request whose cost can't be recorded meanwhile still stops it. */
  stopped?: (request: { host?: string }) => Error | undefined;
  /** A pause is draining the attempt: the error a new paid request is refused with, while the attempt itself goes on. A
   *  request is refused if the pause began before its record is written, even while the host's check of it was running. */
  draining?: () => Error | undefined;
  /** A note the host has for the session's next main-model request, taken by the call (ModelPort.note). */
  note?: (model: string, request?: NoteRequest) => string | undefined;
  /** A note given back by the request that took it, before its admission (ModelPort.noteReturned). */
  noteReturned?: (note: string) => void;
  /** The port ends the attempt (the turn limit, the host's refusal, a cost it could not record): the error it throws. */
  stop?: (reason: "turn_limit" | "refused" | "model_error", message?: string, code?: string) => Error;
  /** The clock a request's record is stamped with (`at`, when it left), in ms since the epoch (default: Date.now). */
  now?: () => number;
}

/** A session's booking of paid model requests: the adapter's model port, and what it has counted. */
export interface ModelBooking {
  /** The port the adapter's session reports every paid request to (`SessionIO.models`). */
  readonly models: ModelPort;
  /** Paid requests that left in this session, one a crash cut off included. */
  turns(): number;
  /** What they cost; null once one's price is unknown. */
  spentUsd(): number | null;
  /** What its host holds for the requests still in flight (admitted, not yet answered): `spentUsd` counts answered ones
   *  only, so a reader of the run's spend that a request overlapping another must see adds this. Null while one in flight
   *  has no hold (never under a cap, which refuses a request it cannot price): unknown, never read as 0. */
  heldUsd(): number | null;
  /** Books, once, each paid request a crash cut off (a `runner.request` with no `runner.turn`): a `runner.turn` marked
   *  `cut`, at its hold as the most it can have cost (CUT_AT_HOLD) or, with none, at an unknown price (one billed to a
   *  plan, its runner.request's `plan`: at $0, `billing: "plan"`), and a `request_end` saying so. A booked request is answered, so this is idempotent.
   *  Call it before the session sends anything. */
  bookCut(): Promise<void>;
}

/** The runner's booking of paid model requests, for a host that drives an adapter session itself (a chat run): the same
 *  records (`runner.request` before a request leaves, `runner.turn` with its cost when it answers), the same turn limit
 *  and `beforeRequest`, the same events. `createHarnessRunner` is built on it. */
export async function modelPortFor(writer: SessionWriter, options: ModelPortOptions): Promise<ModelBooking> {
  return bookingFor(writer, { ...options, records: options.records ?? (await writer.read()) });
}

/** What a session's runner records say: the turn of each paid request that left, in order (`turns`), what its host held
 *  for each (`held`), the label of each the host sent beside the harness's own (`hosts`), which were answered, and the
 *  session's spend (null: unknown). A turn is a paid request that left: counted from the records written before each one
 *  left, so a request a crash cut off (or one still in flight, read from another process or session) counts at the
 *  figure its host held for it, and leaves the spend unknown when there is none. `chargedUsd` is what the answered
 *  requests were charged alone (a crash's cut one at its hold among them), never one still in flight at its hold; null:
 *  one charged has no figure. */
export function sessionSpendOf(records: readonly SessionRecord[]): { turns: number[]; held: Map<number, number>; hosts: Map<number, string>; answered: Set<number>; openHolds: Set<number>; spentUsd: number | null; chargedUsd: number | null; figures: { turn: number; usd: number | null }[]; cost: SessionCost } {
  const requests = records.filter((r) => r.kind === RUNNER_RECORDS.request).map((r) => (r.data ?? {}) as { turn?: number; heldUsd?: unknown; host?: unknown; hold?: unknown });
  const turns = requests.map((data, i) => data.turn ?? i + 1);
  // Hold-only steps (ModelRequest.paid.hold): money reserved, never spent. One still open is no spend here: the process
  // that holds it counts it in flight (runBooking), and a lost claim's is given back (bookCut), never booked as cut.
  const holdOnly = new Set<number>();
  requests.forEach((data, i) => { if (data.hold === true) holdOnly.add(turns[i]!); });
  const hosts = new Map<number, string>();
  requests.forEach((data, i) => { if (typeof data.host === "string") hosts.set(turns[i]!, data.host); });
  // One billed to a person's plan (Admitted.plan) costs the run $0 however it ends: its figure for the cap, held or not,
  // and its cost while it is open, known and never unpriced (turnCostOf's rule once it is booked).
  const onPlan = new Set<number>();
  requests.forEach((data, i) => { if (billedToPlan(data)) onPlan.add(turns[i]!); });
  const held = new Map<number, number>();
  requests.forEach((data, i) => {
    const figure = onPlan.has(turns[i]!) ? 0 : heldFigure(data.heldUsd);
    if (figure !== undefined) held.set(turns[i]!, figure);
  });
  // A request that never answered (a crash or a lost claim cut it; booked cut or not yet) counts for the cap at its hold,
  // its worst case: its whole input uncached and the output it was sent with, so no cache miss bills it more. Unknown with
  // no hold.
  const worst = (turn: number): number | undefined => held.get(turn);
  // Which of them were answered: each runner.turn names its own turn (one written before turns were named answers the
  // earliest still open, as answers then came in order).
  const answered = new Set<number>();
  let spentUsd: number | null = 0;
  // The run's cost (costOfParts): what is known (each booked or reported figure), each cut request booked at its hold
  // apart (`bounded`, the most it can have cost), and how many requests have none. A held figure is the cap's, never a
  // cost: a request without its own figure makes the cost unknown, the known part kept beside it.
  let known = 0;
  let bounded = 0;
  let unpriced = 0;
  let atMost = 0;
  // Each request's figure for the cap, in the order its spend is summed (`spentUsd` is their sum; null: no figure).
  const figures: { turn: number; usd: number | null }[] = [];
  for (const r of records) {
    if (r.kind !== RUNNER_RECORDS.turn) continue;
    const data = r.data as { turn?: number; usd?: number | null; heldUsd?: unknown; bookedUsd?: unknown; cut?: unknown; rule?: unknown };
    // A request is booked once (rebooked): a second runner.turn of a turn already answered counts no money and no request.
    if (rebooked(answered, typeof data.turn === "number" ? data.turn : undefined)) continue;
    const turn = data.turn ?? turns.find((t) => !answered.has(t)) ?? 0;
    answered.add(turn);
    // The figure it was booked at (bookRequest), as written. A record from before that has none: a request cut off with
    // no answer at its worst case; a cost that never came in at the figure its answer was booked at (a stopped request's),
    // else what was held for it.
    const booked = data.bookedUsd === null ? null : heldFigure(data.bookedUsd);
    const cut = data.cut === true && booked === undefined;
    const figure = booked !== undefined ? (booked ?? undefined) : cut ? worst(turn) : data.usd === null ? (heldFigure(data.heldUsd) ?? held.get(turn)) : (data.usd ?? 0);
    spentUsd = spent(spentUsd, figure);
    figures.push({ turn, usd: figure ?? null });
    // Its own cost (turnCostOf): an answer with no price of its own is unknown, never the hold it counts at for the cap; a
    // request cut with no answer and booked at its hold is that figure, the most it can have cost.
    const own = turnCostOf(data);
    if (own.usd === null) unpriced++;
    else if (own.atMost) (bounded += own.usd), atMost++;
    else known += own.usd;
  }
  // Every figure so far is an answered request's: what they were charged, before the open ones count at their holds.
  const chargedUsd = spentUsd;
  const openHolds = new Set<number>();
  for (const turn of turns) {
    if (answered.has(turn)) continue;
    if (holdOnly.has(turn)) {
      openHolds.add(turn);
      continue;
    }
    spentUsd = spent(spentUsd, worst(turn));
    figures.push({ turn, usd: worst(turn) ?? null });
    if (!onPlan.has(turn)) unpriced++;
  }
  return { turns, held, hosts, answered, openHolds, spentUsd, chargedUsd, figures, cost: costOfParts([{ known, bounded, atMost, unpriced }]) };
}

/** A cost's parts, each charge counted by turnCostOf: `known`, the sum of the figures that are a charge's own; `bounded`,
 *  the sum of those that are a cut request's hold (CUT_AT_HOLD), the most each can have cost, and `atMost`, how many those
 *  are; `unpriced`, how many charges have no figure at all. */
export type CostParts = { readonly known: number; readonly bounded: number; readonly atMost: number; readonly unpriced: number };

/** The one rule for a cost made of parts, as every reader of a run's cost says it (the session's, the run's stored cost,
 *  its view and its usage row). Every charge counted: `usd` is their sum, holds included, and `atMost` how many of them are
 *  a hold, so the cost is at most `usd`. Any charge with no figure: `usd` is null, `soFarUsd` the charges' own figures
 *  alone, and `unpriced` counts the held ones with those of no figure. A hold is a ceiling, never spend: beside a cost no
 *  one knows it bounds nothing, so it joins no known sum, where it would read as money spent. */
export function costOfParts(parts: readonly CostParts[]): SessionCost {
  let known = 0;
  let bounded = 0;
  let atMost = 0;
  let unpriced = 0;
  for (const part of parts) (known += part.known), (bounded += part.bounded), (atMost += part.atMost), (unpriced += part.unpriced);
  if (unpriced > 0) return { usd: null, soFarUsd: known, unpriced: unpriced + atMost };
  return { usd: known + bounded, soFarUsd: known + bounded, unpriced: 0, ...(atMost > 0 ? { atMost } : {}) };
}

/** Whether a runner.turn books a request already booked: its turn (`key`, as the reader names it) is in `seen`, which it
 *  joins otherwise. Every reader of a booking (sessionSpendOf, serve's bookedSpend) skips such a record, so a request is
 *  counted once: two bookings of one session that each read it open, or a cut written twice, wrote it twice. A record
 *  with no turn (written before turns were named) is never a repeat. */
export function rebooked<K>(seen: Set<K>, key: K | undefined): boolean {
  if (key === undefined) return false;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

/** The rule (runner.turn `rule`) of a request cut with no answer that bookCut booked at what its host held for it: the
 *  most it can have cost (its whole input uncached and the output it was sent with), marked `atMost`. */
export const CUT_AT_HOLD = "cut";

/** Whether a runner.request (its `data`) is billed to a person's plan (Admitted.plan, its record's `plan`): $0 to the run
 *  however it ends, open or booked. The one check every reader of a booking makes (sessionSpendOf, bookCut, serve's
 *  bookedSpend). */
export const billedToPlan = (data: unknown): boolean => (data as { plan?: unknown } | null | undefined)?.plan === true;

/** A booked request's own cost, from its runner.turn, as every reader of a run's cost reads it (the session's cost, the
 *  run's stored cost and its views): what it was booked at, else its `usd`; null when no one knows it (an answer with no
 *  price of its own booked at its hold for the cap, answeredUnpriced; a request cut with no hold). `atMost`: a request cut
 *  with no answer, booked at its hold (CUT_AT_HOLD), so the figure is the most it can have cost, never less. One billed to
 *  a person's plan (`billing: "plan"`) is $0 to the run however it ended: the plan pays for it, never the run. */
export function turnCostOf(data: { usd?: unknown; bookedUsd?: unknown; cut?: unknown; rule?: unknown; atMost?: unknown; billing?: unknown }): { usd: number | null; atMost: boolean } {
  // Billed to a person's plan (Admitted.plan): no dollars to the run however it ended, answered, stopped or cut.
  if (data.billing === "plan") return { usd: 0, atMost: false };
  if (answeredUnpriced(data)) return { usd: null, atMost: false };
  const booked = data.bookedUsd === null ? null : heldFigure(data.bookedUsd);
  if (booked !== undefined) return { usd: booked, atMost: booked !== null && data.rule === CUT_AT_HOLD && data.atMost === true };
  if (data.cut === true || data.usd === null) return { usd: null, atMost: false };
  return { usd: data.usd === undefined ? 0 : (heldFigure(data.usd) ?? null), atMost: false };
}

/** Whether a request ended with no price of its own (usd null) under a rule that books it at a figure of the host's: an
 *  answer with no cost (bookRequest's rule `answered`, or `answered:<label>`: its hold), or one our side stopped
 *  (`stopped`: what streamed, an estimate) or lost (`lost`, `lost:<label>`: its hold). Each counts for the cap at that
 *  figure, but as a cost it is unknown, never an estimate stored as a known charge (the provider may bill otherwise). */
export const answeredUnpriced = (data: { usd?: unknown; rule?: unknown }): boolean =>
  data.usd === null && typeof data.rule === "string" && (data.rule === "answered" || data.rule.startsWith("answered:") || data.rule === "stopped" || data.rule === "lost" || data.rule.startsWith("lost:"));

/** A session's cost as a person is shown it: `usd` when every paid request has its own figure, else null with the known
 *  part so far (`soFarUsd`, the charges' own figures alone) and how many have none (`unpriced`, a cut request's hold
 *  among them). `atMost`, set only while `usd` is known: how many of its figures are a cut request's hold (turnCostOf),
 *  so the cost is at most what it says (costOfParts). */
export type SessionCost = { usd: number | null; soFarUsd: number; unpriced: number; atMost?: number };

/** A request's booking its own write could not keep, as it would have been written and told: its runner.turn, and the
 *  request_end its host was never sent (with its `holdShort`, when it billed past its hold's bound). */
type Handed = { data: SessionRecord["data"]; usage: ModelUsage; ended?: Ended; holdShort?: HoldShort };
/** The bookings of each session scope (SessionWriter.scope) in this process, across its claims: each request a booking
 *  admitted and has not seen answer (`flying`, settled once its afterRequest has written or failed to), and each answered
 *  request whose runner.turn the store refused (`refused`: a claim lost as the request answered). The scope's next
 *  booking waits for the first and writes the second at its bookCut: a request that answered is booked at what it
 *  reported, once, never cut at an unknown cost because the claim that sent it could no longer write. */
const handoffs = new Map<string, { flying: Map<number, Promise<void>>; refused: Map<number, Handed> }>();
/** How long a bookCut waits for an earlier booking's request still in flight in this process (its claim lost, its loop
 *  stopping, which ends its requests): past it, the request is booked cut as one a dead process left. */
const HANDOFF_WAIT_MS = 10_000;
/** The most scopes kept: past it, the oldest with nothing in flight is dropped (a run resumed in another process, or not
 *  at all, never takes what it left here; its next booking anywhere books those requests cut, as before). */
const HANDOFF_SCOPES_MAX = 1024;
const handoffOf = (scope: string) => {
  let at = handoffs.get(scope);
  if (!at) {
    at = { flying: new Map(), refused: new Map() };
    handoffs.set(scope, at);
    if (handoffs.size > HANDOFF_SCOPES_MAX) for (const [key, old] of handoffs) if (old.flying.size === 0 && key !== scope) { handoffs.delete(key); break; }
  }
  return at;
};
const handoffDone = (scope: string) => {
  const at = handoffs.get(scope);
  if (at && at.flying.size === 0 && at.refused.size === 0) handoffs.delete(scope);
};

function bookingFor(writer: SessionWriter, options: ModelPortOptions & { records: readonly SessionRecord[] }): ModelBooking {
  const node = { key: options.key, label: options.label ?? options.key, ...(options.executionPath === undefined ? {} : { executionPath: options.executionPath }) };
  const limit = options.maxTurns ?? null;
  const append = options.append ?? ((records: SessionRecord[]) => writer.append(records));
  const emit = (event: ModelPortEvent) => options.onEvent?.({ ...event, ...node });
  // What this session's records say when it opens (sessionSpendOf).
  const read = sessionSpendOf(options.records);
  const inherited = read.turns;
  const hosts = read.hosts;
  let turns = inherited.length;
  const held = read.held;
  /** What the host counts each request of this process at if its client stops it part way (Admission.stoppedUsd). */
  const stoppedAt = new Map<number, (streamedTokens: number) => number>();
  /** The host's record of a note each request of this process carries (Admission.note), for its runner.turn. */
  const notes = new Map<number, { [key: string]: JsonValue }>();
  /** The requests of this process on a free model (Admitted.free): each booked a known $0 however it ends. */
  const freeTurns = new Set<number>();
  /** The requests of this process billed to a plan (Admitted.plan): each booked $0 to the run however it ends. */
  const planTurns = new Set<number>();
  const answered = read.answered;
  let spentUsd: number | null = read.spentUsd;
  // The ids each request's response gave it, kept as its headers arrived: a request cut off after them reached the provider.
  const responses = new Map<number, Record<string, string>>();
  for (const r of options.records) {
    if (r.kind !== RUNNER_RECORDS.response) continue;
    const data = r.data as { turn?: number; providerIds?: Record<string, string> };
    if (typeof data.turn === "number" && data.providerIds) responses.set(data.turn, data.providerIds);
  }
  // This process's requests in flight, oldest first: the turn each was admitted as, and its model.
  const open: InFlight[] = [];
  // Each of them as the session's scope knows it in flight (handoffs), settled once its afterRequest has written or not.
  const scope = writer.scope;
  const settles = new Map<number, () => void>();
  const fly = (turn: number) => {
    if (scope === undefined) return;
    let settle!: () => void;
    const flying = handoffOf(scope).flying;
    const done = new Promise<void>((resolve) => (settle = resolve));
    flying.set(turn, done);
    settles.set(turn, () => {
      settles.delete(turn);
      if (flying.get(turn) === done) flying.delete(turn);
      settle();
      handoffDone(scope);
    });
  };
  // Response ids whose own write was refused, marked `late`: the booking's next write of its own (the next runner.request,
  // or a runner.turn) carries them first, so a request this process cuts by dying after that still keeps its ids. One a
  // runner.turn writes with the ids is dropped, never written twice. A process that dies before writing for its booking
  // again loses them: the request is then booked once, cut, at an unknown cost, with no ids.
  let carry: SessionRecord[] = [];
  const write = async (records: SessionRecord[], covers: (record: SessionRecord) => boolean = () => false) => {
    const taken = carry;
    carry = [];
    try {
      await append([...taken.filter((r) => !covers(r)), ...records]);
    } catch (error) {
      carry = [...taken, ...carry];
      throw error;
    }
  };
  // Admissions run one at a time (the turn limit, the host's check and the durable write), so two requests asked for at
  // once can't both pass a limit only one fits; the requests themselves still run side by side once admitted.
  let admitting: Promise<unknown> = Promise.resolve();
  // A paid request whose cost couldn't be recorded stops the booking itself, whether or not the host gave it a stop.
  let failed: Error | undefined;
  const end = (reason: "turn_limit" | "refused" | "model_error", message?: string, code?: string): Error =>
    options.stop ? options.stop(reason, message, code) : new HarnessRunError(reason, turns, 0, { maxTurns: limit, ...(message === undefined ? {} : { message }), ...(code === undefined ? {} : { refusal: code }) });
  const admit = async ({ model, inputTokensMax: measured, outputTokensAsked, outputTokensLeast, feeUsd, paid, side, unanswered, noted, inputTokensMaxWithoutNote, host, route, signal }: ModelRequest): Promise<ModelTicket> => {
    let inputTokensMax = measured;
    const stopped = options.stopped?.(host === undefined ? {} : { host }) ?? failed;
    if (stopped) throw stopped;
    const pausing = options.draining?.();
    if (pausing) throw pausing;
    if (limit !== null && turns >= limit) throw end("turn_limit");
    // A host that makes the request wait for room (runBooking) lets it go at its client's abort or the booking's own stop.
    const halted = () => options.stopped?.(host === undefined ? {} : { host }) ?? failed ?? options.draining?.();
    const verdict = await options.beforeRequest?.({ ...node, model, turn: turns + 1, maxTurns: limit, ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }), spentUsd, inFlight: open.map((f) => ({ ...f })), inputTokensMax, ...(signal ? { signal } : {}), halted,
      ...(outputTokensAsked === undefined ? {} : { outputTokensAsked }), ...(outputTokensLeast === undefined ? {} : { outputTokensLeast }), ...(feeUsd === undefined ? {} : { feeUsd }), ...(paid ? { paid } : {}), ...(side ? { side } : {}), ...(unanswered ? { unanswered } : {}), ...(noted ? { noted,...(inputTokensMaxWithoutNote === undefined ? {} : { inputTokensMaxWithoutNote }) } : {}), ...(host === undefined ? {} : { host }), ...(route === undefined ? {} : { route }) });
    if (verdict && "refuse" in verdict) throw end("refused", verdict.refuse, typeof verdict.code === "string" ? verdict.code : undefined);
    const hold = verdict && "holdUsd" in verdict ? heldFigure(verdict.holdUsd) : undefined;
    // Admitted only without the note: it goes as its client sent it, measured so.
    const withoutNote = noted === true && !!verdict && "withoutNote" in verdict && verdict.withoutNote === true;
    if (withoutNote) inputTokensMax = inputTokensMaxWithoutNote;
    // The output limit the host admits it with goes into its body. A limit that is no whole number of tokens above 0 (a
    // fraction, 0, a negative, NaN) can't be sent, so the request is refused before anything is written: dropping it would
    // send the request with no limit at all. Only a verdict with no limit sends the request with none.
    const limited = verdict && "outputTokensMax" in verdict ? verdict.outputTokensMax : undefined;
    if (limited !== undefined && !(Number.isSafeInteger(limited) && limited > 0)) throw end("refused", `the request was not sent: its output limit (${String(limited)}) is not a whole number of tokens above 0`);
    // A stop or a pause that came while the host was checking: nothing was written for this request, so it is refused, not
    // sent. After the write below it is committed (refusing it then would leave a recorded request that was never sent).
    const late = options.stopped?.(host === undefined ? {} : { host }) ?? failed ?? options.draining?.();
    if (late) throw late;
    // Durable before the request leaves: admitted, then sent. It counts as a turn once its record is written (admissions
    // run one at a time), so a write that fails refuses the request and costs no turn.
    const turn = turns + 1;
    // Billed to a plan (Admitted.plan), or counted toward the run's free-model limit (Admitted.freeRequest): said on its
    // record, so a later process that books it cut books it so, and the next count holds it. Never both (runCap).
    const onPlan = !!verdict && "plan" in verdict && verdict.plan === true;
    const freeRequest = !!verdict && "freeRequest" in verdict && verdict.freeRequest === true;
    const localRequest = !!verdict && "localRequest" in verdict && verdict.localRequest === true;
    // A paid tool call (ModelRequest.paid) says so on its record (`paid`), so a later process that books it cut knows its
    // hold is its fee as admitted, never a bound on what its provider charged (bookCut).
    // `at`: when it left, so a reader shows a request still in flight from its start (a run page's live row), and
    // `inputTokensMax`, the input it was admitted with, beside it.
    const modelName = route === undefined ? undefined : options.modelNamesByRoute?.get(route);
    await write([{ kind: RUNNER_RECORDS.request, data: { turn, model, ...(modelName === undefined ? {} : { modelName }), at: new Date((options.now ?? Date.now)()).toISOString(), ...(inputTokensMax === undefined ? {} : { inputTokensMax }), ...(paid ? { paid: true as const } : {}), ...(hold === undefined ? {} : { heldUsd: hold }), ...(onPlan ? { plan: true as const } : {}), ...(freeRequest ? { freeRequest: true as const } : {}), ...(localRequest ? { localRequest: true as const } : {}), ...(side ? { side } : {}), ...(host === undefined ? {} : { host }), ...(paid?.call === undefined ? {} : { call: paid.call }), ...(paid?.charged_by === undefined ? {} : { charged_by: paid.charged_by }), ...(paid?.tool === undefined ? {} : { tool: paid.tool }), ...(paid?.tag === undefined ? {} : { tag: paid.tag }), ...(paid?.owed ? { owed: true as const } : {}), ...(paid?.hold ? { hold: true as const } : {}), ...(paid?.ref === undefined ? {} : { ref: paid.ref }), ...(paid?.reported ? { reported: true as const } : {}) } }]);
    turns = turn;
    if (host !== undefined) hosts.set(turn, host);
    if (hold !== undefined) held.set(turn, hold);
    const stoppedUsd = verdict && "stoppedUsd" in verdict && typeof verdict.stoppedUsd === "function" ? verdict.stoppedUsd : undefined;
    if (stoppedUsd) stoppedAt.set(turn, stoppedUsd);
    const note = verdict && "note" in verdict && verdict.note && typeof verdict.note === "object" && !withoutNote ? verdict.note : undefined;
    if (note) notes.set(turn, note);
    if (verdict && "free" in verdict && verdict.free === true) freeTurns.add(turn);
    if (onPlan) planTurns.add(turn);
    // A stop that came while the record was written: the request has not left. It is booked withdrawn, at $0, so no
    // later process books it as cut at an unknown price; if that write fails, it is booked cut, which is never less.
    // Its record is written, so it costs a turn of the cap, never money.
    const stoppedNow = options.stopped?.(host === undefined ? {} : { host });
    if (stoppedNow) {
      answered.add(turn);
      // Through the booking's own write: a response's ids still waiting to be carried go with the withdrawal.
      await write([{ kind: RUNNER_RECORDS.turn, data: { turn, usd: 0, unsent: true } }]).catch(() => undefined);
      throw stoppedNow;
    }
    // The host's start mark, awaited before the request leaves (its handler commits and syncs it). One it refuses is
    // booked as a stop is, withdrawn at $0, and the request never joins the open ones, which a ticketless answer reads.
    try {
      await emit({ type: "request_start", turn, model, ...(host === undefined ? {} : { host }) });
    } catch (error) {
      answered.add(turn);
      await write([{ kind: RUNNER_RECORDS.turn, data: { turn, usd: 0, unsent: true } }]).catch(() => undefined);
      throw error;
    }
    // A stop that came while the mark was made: the request has not left either. Booked withdrawn as above, and its end
    // told to the host, whose mark has it started: at $0, so the host never reads it cut at an unknown price.
    const stoppedLate = options.stopped?.(host === undefined ? {} : { host });
    if (stoppedLate) {
      answered.add(turn);
      await write([{ kind: RUNNER_RECORDS.turn, data: { turn, usd: 0, unsent: true } }]).catch(() => undefined);
      await emit({ type: "request_end", turn, usage: { input: 0, output: 0, cacheRead: 0, usd: 0 }, ...(host === undefined ? {} : { host }), ended: { end: "nothing", label: "never_left" } });
      throw stoppedLate;
    }
    open.push({ turn, model, inputTokensMax, ...(limited === undefined ? {} : { outputTokensMax: limited }), ...(hold === undefined ? {} : { holdUsd: hold }), ...(host === undefined ? {} : { host }), ...(route === undefined ? {} : { route }), ...(paid?.hold ? { stays: true as const } : {}) });
    fly(turn);
    // The cap's figures for a cut of its answer, only with the limit they are about.
    const capCut = limited !== undefined && verdict && "capCut" in verdict && verdict.capCut ? verdict.capCut : undefined;
    return { turn, ...(limited === undefined ? {} : { outputTokensMax: limited }), ...(withoutNote ? { noteDropped: true as const } : {}), ...(capCut ? { capCut } : {}) };
  };
  const models: ModelPort = {
    ...(options.note ? { note: options.note } : {}),
    ...(options.noteReturned ? { noteReturned: options.noteReturned } : {}),
    beforeRequest: (request: ModelRequest) => {
      const admitted = admitting.then(() => admit(request));
      admitting = admitted.catch(() => {});
      return admitted;
    },
    responded: async (ids: Record<string, string>, ticket?: ModelTicket) => {
      const turn = ticket?.turn ?? open[0]?.turn ?? turns;
      try {
        await append([{ kind: RUNNER_RECORDS.response, data: { turn, providerIds: ids } }]);
      } catch (error) {
        // Refused (a commit that timed out, say): the proxy goes on with the answer, and the ids wait for the next write.
        carry.push({ kind: RUNNER_RECORDS.response, data: { turn, providerIds: ids, late: true } });
        throw error;
      }
    },
    afterRequest: async (usage: ModelUsage, ticket?: ModelTicket, ended?: Ended) => {
      // The turn this request was admitted as (its ticket; without one, the earliest still in flight).
      const turn = ticket?.turn ?? open[0]?.turn ?? turns;
      const at = open.findIndex((f) => f.turn === turn);
      // As it was admitted: the bound its hold was priced on (holdShortOf).
      const flight = at >= 0 ? open[at] : undefined;
      if (at >= 0) open.splice(at, 1);
      // A cost that never came in (a response cut short): at what the host held for the request, else unknown. One its
      // client stopped part way at what the host counts it at by what streamed (one token a byte), never more than that.
      const hold = held.get(turn);
      const stoppedUsd = stoppedAt.get(turn);
      stoppedAt.delete(turn);
      const note = notes.get(turn);
      notes.delete(turn);
      // Billed to a plan: so booked however it ended (a cut or a stop reports no usage that says so), at $0 for the cap
      // as its hold is, and $0 to the run (turnCostOf).
      const plan = planTurns.delete(turn);
      if (plan && usage.billing === undefined) usage = { ...usage, billing: "plan" };
      // On a free model nothing it was billed for costs anything: its own cost is a known $0, never unknown. A cost its
      // provider reported above $0 is a cost all the same: booked as it is, never free. A request billed to a plan is the
      // plan's, at no price here, whatever its listing says: never free.
      const free = freeTurns.delete(turn) && usage.billing === undefined && (usage.usd === null || usage.usd === 0);
      if (free) usage = { ...usage, usd: 0, free };
      // Its hidden reasoning counts beside all it sent, less the reasoning it sent: max(0, budget - reasoning bytes), so
      // reasoning that streamed is not counted twice and answer text never stands in for it.
      const figure0 = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
      const hidden = figure0(usage.stoppedHiddenTokens);
      const reasoned = figure0(usage.stoppedReasoningBytes);
      const sent = typeof usage.stoppedAfterBytes === "number" && usage.stoppedAfterBytes >= 0 ? usage.stoppedAfterBytes : undefined;
      const stopped = usage.usd === null && hold !== undefined && stoppedUsd && sent !== undefined ? heldFigure(stoppedUsd(sent + Math.max(0, hidden - reasoned))) : undefined;
      // How its path saw it end, booked by the one rule (booking.ts); a host from before that says nothing of it: as
      // before, its own cost, else what streamed of a stop, else the hold.
      const booking = ended ? bookRequest(ended, { ...(hold === undefined ? (plan ? { hold: 0 } : {}) : { hold }), ...(stoppedUsd ? { stoppedPrice: stoppedUsd } : {}), ...(free ? { free } : {}) }) : undefined;
      const figure = booking ? booking.usd : usage.usd !== null ? usage.usd : stopped === undefined ? hold : Math.min(hold!, stopped);
      spentUsd = spent(spentUsd, figure ?? undefined);
      const settle = settles.get(turn);
      const data: SessionRecord["data"] = { turn, usd: usage.usd, ...tokensOf(usage), ...(usage.givenBack ? { givenBack: true } : {}), ...(usage.estimated ? { estimated: true } : {}), ...(usage.tableUsd === undefined ? {} : { tableUsd: usage.tableUsd }), ...(usage.billing ? { billing: usage.billing } : {}), ...(usage.providerIds ? { providerIds: usage.providerIds } : {}), ...(stopped === undefined ? {} : { heldUsd: Math.min(hold!, stopped), stopped: true }), ...(booking ? { bookedUsd: booking.usd, rule: booking.rule } : {}), ...(ended?.end === "nothing" && ended.label === "refused" && ended.reason ? { refusal: ended.reason } : {}), ...(ended?.end === "answered" && ended.label === "error" && ended.reason ? { providerError: ended.reason } : {}), ...(note ? { note } : {}) };
      // Marked so, for a reader to say why it cost nothing (a run on free models: "$0 · free model").
      if (free) data.free = true;
      // Billed past the bound its hold was priced on: told with its end, for the host's warn line, here or, its write
      // refused, by the next booking that writes it (handoffs). Its booking is as above.
      const holdShort = holdShortOf(usage, flight, hold, plan || free);
      try {
        // A runner.turn with the ids holds what a carried response record of this turn would: that one is dropped. A
        // stopped one keeps the figure it counts at (`heldUsd`), so a later process counts it the same.
        const covers = (r: SessionRecord) => usage.providerIds !== undefined && (r.data as { turn?: number }).turn === turn;
        await write([{ kind: RUNNER_RECORDS.turn, data }], covers);
        settle?.();
      } catch (error) {
        // Refused (its claim lost as it answered, say): the booking is handed to the session's next booking in this
        // process, which writes it at its bookCut, never cutting a request that answered (handoffs).
        if (scope !== undefined) handoffOf(scope).refused.set(turn, { data, usage, ...(ended ? { ended } : {}), ...(holdShort ? { holdShort } : {}) });
        settle?.();
        // A paid request whose cost can't be kept: the attempt stops, saying so, rather than spend on uncounted. Asked
        // with the request's own host label, as its admission was: a stop that holds only the harness's own requests (a
        // parked turn's) never hides the failure from the host's. A turn parked on a call (TurnParked) is no stop of the
        // booking, so it stops here too; a stop that ended it already wins.
        const host = hosts.get(turn);
        const stop = options.stopped?.(host === undefined ? {} : { host });
        if (!stop || stop instanceof TurnParked) failed ??= end("model_error", `harness node stopped: the cost of a paid request could not be recorded: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
        throw error;
      }
      answered.add(turn);
      const hosted = hosts.get(turn);
      // Awaited: a host that marks the request's end on its record writes it before the booking counts as settled, so a
      // run's end never lands ahead of the mark that says its request was cut.
      await emit({ type: "request_end", turn, usage, ...(hosted === undefined ? {} : { host: hosted }), ...(ended ? { ended } : {}), ...(holdShort ? { holdShort } : {}) });
    },
  };
  // One booking of the cut requests at a time: a call made while one is writing waits for it, never books them again.
  let cutting: Promise<void> | undefined;
  const bookCut = async () => {
    // A paid request a crash cut off kept its runner.request and has no runner.turn: the provider may have billed it.
    // Each is booked once, as cut, at an unknown price, and the host is told as for any answered request, so its ledger
    // shows the possible spend instead of nothing. Booked, it is answered: a later attempt never books it again.
    // Only requests an earlier process admitted: one this process has in flight is not cut. Read again here, just before
    // the cut is written: another booking of this session (an earlier pass of this claim, or one racing it) may have
    // booked it since this one opened, and a request is booked once.
    // An earlier booking of this session in this process (a claim lost, then taken again here) may still have one of them
    // in flight: its end is waited for, bounded, so a request that answers meanwhile is booked by what it reported.
    const before = scope === undefined ? undefined : handoffs.get(scope);
    const flying = before ? inherited.filter((t) => !answered.has(t)).flatMap((t) => before.flying.get(t) ?? []) : [];
    if (flying.length) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(flying), new Promise<void>((resolve) => (timer = setTimeout(resolve, HANDOFF_WAIT_MS)))]);
      clearTimeout(timer);
    }
    const now = await writer.read().catch(() => options.records);
    // Every record this pass appends after that read (a handed-on answer, a given-back hold, an owed step, a free cut), in
    // order: a spend rebuilt from the session's records reads `now` and these, so a request booked earlier in the pass
    // counts at what it was booked at, never at the hold `now` still has it open at.
    const booked: SessionRecord[] = [];
    const book = async (records: SessionRecord[]) => {
      await append(records);
      booked.push(...records);
    };
    const bookedSince = sessionSpendOf(now).answered;
    for (const t of inherited) if (bookedSince.has(t)) answered.add(t);
    // A request an earlier booking in this process saw answer, whose runner.turn its store refused: written now as that
    // booking would have written it, and told as it would have told it, at what it reported. One the session booked since
    // is dropped: a request is booked once.
    const handed = scope === undefined ? undefined : handoffs.get(scope);
    if (scope !== undefined && handed) {
      for (const t of inherited) if (answered.has(t)) handed.refused.delete(t);
      const taken = inherited.flatMap((turn) => {
        const one = handed.refused.get(turn);
        return one ? [{ turn, ...one }] : [];
      });
      if (taken.length) {
        await book(taken.map((one) => ({ kind: RUNNER_RECORDS.turn, data: one.data })));
        for (const one of taken) {
          handed.refused.delete(one.turn);
          answered.add(one.turn);
        }
        // Its spend read the request at its hold (or unknown); booked, it reads at what it was booked at. Only
        // before this booking's own requests: the spend is the session's records then.
        if (turns === inherited.length && open.length === 0) spentUsd = sessionSpendOf([...now, ...booked]).spentUsd;
        for (const one of taken) {
          const hosted = hosts.get(one.turn);
          await emit({ type: "request_end", turn: one.turn, usage: one.usage, ...(hosted === undefined ? {} : { host: hosted }), ...(one.ended ? { ended: one.ended } : {}), ...(one.holdShort ? { holdShort: one.holdShort } : {}) });
        }
      }
      handoffDone(scope);
    }
    const left = inherited.filter((t) => !answered.has(t));
    if (left.length === 0) return;
    // A hold-only step an earlier process left open is given back: money reserved, not spent (its holder's charges book
    // the money), never booked as cut. Every other cut step keeps the rule below.
    const givenBack = left.filter((t) => read.openHolds.has(t));
    // An owed step (money already owed at its provider, at the figure it was held at: a browser charge) an earlier process
    // left open is booked at that figure, its known cost, never as an unknown cut: what it owes was settled when it was
    // admitted, and its settle alone was lost.
    const owedTurns = new Set(options.records.filter((r) => r.kind === RUNNER_RECORDS.request).flatMap((r, i) => {
      const data = (r.data ?? {}) as { owed?: unknown; hold?: unknown };
      return data.owed === true && data.hold !== true ? [inherited[i]!] : [];
    }));
    const owed = left.filter((t) => !read.openHolds.has(t) && owedTurns.has(t) && (held.get(t) ?? 0) > 0);
    // A request on a free model (its runner.request says `freeRequest`, or `localRequest` for a local one, as the run's cap
    // admitted it) an earlier process left open costs nothing whatever reached the provider: booked cut at a known $0 and
    // marked `free`, as this process books its own (bookRequest's free), never unknown. Any other keeps the rule below.
    const freeTurns = new Set(options.records.filter((r) => r.kind === RUNNER_RECORDS.request).flatMap((r, i) => {
      const data = (r.data ?? {}) as { turn?: unknown; freeRequest?: unknown; localRequest?: unknown };
      return data.freeRequest === true || data.localRequest === true ? [typeof data.turn === "number" ? data.turn : i + 1] : [];
    }));
    const free = left.filter((t) => !read.openHolds.has(t) && !owed.includes(t) && freeTurns.has(t));
    const numbers = left.filter((t) => !read.openHolds.has(t) && !owed.includes(t) && !free.includes(t));
    if (givenBack.length) {
      await book(givenBack.map((turn) => ({ kind: RUNNER_RECORDS.turn, data: { turn, usd: 0, givenBack: true } })));
      for (const turn of givenBack) answered.add(turn);
    }
    if (owed.length) {
      await book(owed.map((turn) => ({ kind: RUNNER_RECORDS.turn, data: { turn, usd: held.get(turn)!, bookedUsd: held.get(turn)!, rule: "owed" } })));
      for (const turn of owed) {
        answered.add(turn);
        const hosted = hosts.get(turn);
        emit({ type: "request_end", turn, usage: { input: 0, output: 0, cacheRead: 0, usd: held.get(turn)!, estimated: true }, ...(hosted === undefined ? {} : { host: hosted }) });
      }
    }
    // A cut request whose response had begun carries the ids it gave: the provider saw it, under them. One with none may
    // still have reached the provider before any answer. Neither left a figure of its own (the process that would have
    // read what it reported is gone): one its host held a figure for is booked at that hold, the most it can have cost
    // (CUT_AT_HOLD, `atMost`), so the run's cost stays known and says it is an upper bound; one with no hold (no cap) is
    // booked at an unknown price, as no one can bound it. A hold of $0 (no cap's) bounds nothing, and a paid tool call's
    // (its runner.request's `paid`) is its fee as admitted, not what its provider may have charged: both stay unknown.
    // One billed to a person's plan (its runner.request's `plan`) costs the run $0 however it ended: booked cut at $0,
    // marked as the plan's (`billing`), a known figure, never an unknown that blanks the run's cost.
    // Each request left open is in exactly one class, taken in this order: given back (an open hold-only step), owed (its
    // figure settled at admission), free (`freeRequest`: a known $0, `free`), then `numbers`, where a plan request books $0
    // billing "plan" and any other at its hold (`atMost`) or unknown. A request is never both free and plan: the cap marks
    // a plan request `plan` before it looks at free, and freeModel refuses a plan model, so no plan request is admitted
    // `freeRequest`.
    const modelTurns = new Set(options.records.filter((r) => r.kind === RUNNER_RECORDS.request).flatMap((r, i) => ((r.data as { paid?: unknown } | undefined)?.paid === true ? [] : [inherited[i]!])));
    const onPlan = new Set(options.records.filter((r) => r.kind === RUNNER_RECORDS.request).flatMap((r, i) => (billedToPlan(r.data) ? [inherited[i]!] : [])));
    const boundOf = (turn: number): number | undefined => {
      const hold = held.get(turn);
      return hold !== undefined && hold > 0 && modelTurns.has(turn) ? hold : undefined;
    };
    const cutOf = (turn: number): SessionRecord["data"] => {
      const providerIds = responses.get(turn);
      if (onPlan.has(turn)) return { usd: null, cut: true, turn, bookedUsd: 0, rule: CUT_AT_HOLD, billing: "plan", ...(providerIds ? { providerIds } : {}) };
      const hold = boundOf(turn);
      return { usd: null, cut: true, turn, ...(hold === undefined ? {} : { bookedUsd: hold, rule: CUT_AT_HOLD, atMost: true }), ...(providerIds ? { providerIds } : {}) };
    };
    if (free.length) {
      await book(free.map((turn) => {
        const providerIds = responses.get(turn);
        return { kind: RUNNER_RECORDS.turn, data: { usd: 0, cut: true, turn, ...(providerIds ? { providerIds } : {}), bookedUsd: 0, rule: "lost:cut", free: true } };
      }));
      for (const turn of free) {
        answered.add(turn);
        const providerIds = responses.get(turn);
        const hosted = hosts.get(turn);
        emit({ type: "request_end", turn, usage: { input: 0, output: 0, cacheRead: 0, usd: 0, cut: true, free: true, ...(providerIds ? { providerIds } : {}) }, ...(hosted === undefined ? {} : { host: hosted }), ended: { end: "lost", label: "cut" } });
      }
      // Its spend read the request at its hold (or unknown); booked, it reads at $0. Only before this booking's own
      // requests: the spend is the session's records then, every one this pass booked above included (a handed-on answer
      // at what it reported, an owed step at its booked figure).
      if (turns === inherited.length && open.length === 0) spentUsd = sessionSpendOf([...now, ...booked]).spentUsd;
    }
    if (numbers.length === 0) return;
    await append(numbers.map((turn) => ({ kind: RUNNER_RECORDS.turn, data: cutOf(turn) })));
    for (const turn of numbers) answered.add(turn);
    // The spend already counts each of them, at its hold or as unknown: booking them adds nothing.
    for (const turn of numbers) {
      const providerIds = responses.get(turn);
      const hosted = hosts.get(turn);
      const hold = onPlan.has(turn) ? undefined : boundOf(turn);
      emit({ type: "request_end", turn, usage: { input: 0, output: 0, cacheRead: 0, usd: null, estimated: true, cut: true, ...(hold === undefined ? {} : { atMostUsd: hold }), ...(onPlan.has(turn) ? { billing: "plan" as const } : {}), ...(providerIds ? { providerIds } : {}) }, ...(hosted === undefined ? {} : { host: hosted }), ended: { end: "lost", label: "cut" } });
    }
  };
  return {
    models,
    turns: () => turns,
    spentUsd: () => spentUsd,
    heldUsd: () => open.reduce<number | null>((sum, flight) => (sum === null || flight.holdUsd === undefined ? null : sum + flight.holdUsd), 0),
    bookCut() {
      cutting ??= bookCut().catch((error) => {
        cutting = undefined;
        throw error;
      });
      return cutting;
    },
  };
}

/** A booking's tokens as its runner.turn keeps them (`usage`, in pi's shape: `input` excludes cached tokens), or nothing
 *  when it reports none: a request whose usage was not read is booked with zeros, which are no count. */
function tokensOf(usage: ModelUsage): { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } } {
  const tokens = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 };
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0 ? { usage: tokens } : {};
}

const NUDGE = "You finished without an accepted submission. Call submit with the complete result; plain text does not deliver it.";

export function createHarnessRunner(adapter: AgentAdapter, options: HarnessRunnerOptions): HarnessRunner {
  const maxTurns = options.maxTurns === null ? null : positive(options.maxTurns ?? 8, "maxTurns");
  const maxSends = positive(options.maxSends ?? 100, "maxSends");
  const maxSubmissions = options.maxSubmissions === null ? null : positive(options.maxSubmissions ?? 5, "maxSubmissions");
  const timeoutMs = options.timeoutMs === null ? null : positive(options.timeoutMs ?? 120_000, "timeoutMs");
  const registered = new Map<string, HostTool>();
  for (const tool of options.tools ?? []) {
    if (tool.name === SUBMIT_TOOL || registered.has(tool.name)) throw new Error(`Reserved or duplicate harness tool: ${tool.name}`);
    registered.set(tool.name, tool);
  }
  const store = options.store;
  /** The nodes running now, each by how it is paused; and whether the runner was stopped. */
  const running = new Map<Promise<unknown>, (drainMs: number) => Promise<void>>();
  let halted = false;

  const runNode = async (request: NodeRequest, pause: (drain: (drainMs: number) => Promise<void>) => void): Promise<unknown> => {
    // Without a step there is no durable identity: a fresh session of the runner's own, never one derived from the
    // label, which map items and loops repeat.
    const key = request.step ? `step:${request.step.sessionId}` : `call:${randomUUID()}`;
    const node = { key, label: request.label, ...(request.executionPath === undefined ? {} : { executionPath: request.executionPath }) };
    const emit = (event: AdapterEvent | { type: "request_start"; turn: number; model: string } | { type: "request_end"; turn: number; usage: ModelUsage; ended?: Ended }) => options.onEvent?.({ ...event, ...node } as HarnessEvent);
    const refuse = (message: string, turns = 0, submissions = 0) => new HarnessRunError("refused", turns, submissions, { message });

    const signals = [options.signal, request.signal].filter((s): s is AbortSignal => Boolean(s));
    if (halted || signals.some((s) => s.aborted)) throw new HarnessRunError("aborted", 0, 0);
    if (request.maxTurns !== undefined) {
      positive(request.maxTurns, "maxTurns");
      if (maxTurns !== null && request.maxTurns > maxTurns) throw refuse(`Node "${request.label}" asks max_turns ${request.maxTurns}, above this host's cap of ${maxTurns} turns`);
    }
    const limit = request.maxTurns ?? maxTurns;
    // Absent: every registered tool. An unknown name is refused, never dropped.
    const requested = request.tools ?? [...registered.keys()];
    for (const name of requested) if (!registered.has(name)) throw refuse(`Node "${request.label}" names the tool ${name}, which this host does not give ${adapter.id} nodes`);

    // This attempt takes the session before it reads it: from here a process that held it earlier (one whose lease
    // lapsed while it was still alive) can write nothing more into it, a runner.accepted included.
    const writer = await store.open(key);
    // A session that already delivered: its record, and nothing runs.
    const earlier = request.step ? await writer.read() : [];
    const delivered = earlier.findLast((r) => r.kind === RUNNER_RECORDS.accepted);
    if (delivered) return structuredClone((delivered.data as { value: unknown }).value);

    const validator = Compile(request.schema as never);
    const parameters = submitParameters(request.schema);
    const envelope = Compile(parameters as never);
    let submissions = earlier.filter((r) => r.kind === RUNNER_RECORDS.submit).length;
    // The session's paid requests, counted and booked by its model port (modelPortFor), made once `append` exists below.
    let booking!: ModelBooking;
    const turnsSoFar = () => booking?.turns() ?? 0;
    let accepted = false;
    let submission: unknown;
    let lastTool: string | undefined;
    let stopped: HarnessRunError | undefined;
    // A pause in progress: nothing new starts, and the node stops once its session has drained.
    let draining = false;
    // Calls the session announced (tool_start) before the pause: they are in flight, not new, and run on through a drain.
    // A stop with no drain (drainMs 0) lets nothing run on, announced or not.
    const announced = new Set<string>();
    let immediate = false;
    const failure = (reason: HarnessRunError["reason"], message?: string, code?: string) =>
      new HarnessRunError(reason, turnsSoFar(), submissions, { maxTurns: limit, ...(lastTool === undefined ? {} : { lastTool }), ...(message === undefined ? {} : { message }), ...(code === undefined ? {} : { refusal: code }) });

    const controller = new AbortController();
    let rejectStopped!: (error: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectStopped = reject; });
    void interrupted.catch(() => {});
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, interrupted]);
    const stop = (error: HarnessRunError) => {
      stopped ??= error;
      rejectStopped(stopped);
      controller.abort(stopped);
    };
    const onAbort = () => stop(failure("aborted"));
    const append = async (records: SessionRecord[]) => {
      try {
        await writer.append(records);
      } catch (error) {
        // A newer process holds the session: this attempt stops, and what it was writing never counts.
        if (error instanceof SessionFenced) { stop(failure("fenced")); throw stopped; }
        throw error;
      }
    };
    booking = bookingFor(writer, {
      ...node, maxTurns: limit, records: earlier, append,
      ...(request.budgetUsd === undefined ? {} : { budgetUsd: request.budgetUsd }),
      ...(options.beforeRequest ? { beforeRequest: options.beforeRequest } : {}),
      onEvent: (event) => emit(event),
      stopped: () => stopped,
      draining: () => (draining ? failure("aborted", "harness node pausing: no new paid request") : undefined),
      stop: (reason, message, code) => { stop(failure(reason, message, code)); return stopped!; },
    });

    const submit: HostTool = {
      name: SUBMIT_TOOL,
      description: "Deliver a result matching the required JSON Schema. Rejection feedback must be corrected in this session.",
      inputSchema: parameters,
      replay: "safe",
      async call(args) {
        if (accepted) return { text: "Already accepted; end your turn." };
        // A stop with no drain takes no answer, though one inside a drain is kept (it is the end of a paid response).
        if (stopped || (draining && immediate)) return { text: "This session has stopped.", isError: true };
        submissions += 1;
        await append([{ kind: RUNNER_RECORDS.submit, data: { n: submissions } }]);
        const candidate = (args as { value?: unknown } | null)?.value;
        let message: string | undefined;
        if (!envelope.Check(args)) message = JSON.stringify([...envelope.Errors(args)]);
        else if (!validator.Check(candidate)) message = JSON.stringify([...validator.Errors(candidate)]);
        else if (request.review) {
          const verdict = await request.review(candidate);
          if (!verdict.accepted) message = reviewRejection(verdict.message);
          else if (!validator.Check(candidate)) message = "The reviewed candidate no longer satisfies its output schema";
        }
        if (stopped) return { text: "This session has stopped.", isError: true };
        if (message !== undefined) {
          if (maxSubmissions !== null && submissions >= maxSubmissions) stop(failure("submission_limit"));
          return { text: `Rejected: ${message}. Correct the result and call submit again.`, isError: true };
        }
        // Durable before it is acknowledged: a process that dies after this answers the step from the record.
        await append([{ kind: RUNNER_RECORDS.accepted, data: { value: structuredClone(candidate) as never } }]);
        submission = structuredClone(candidate);
        accepted = true;
        return { text: "Accepted. End your turn." };
      },
    };
    const guard = (tool: HostTool): HostTool => ({
      ...tool,
      call: (args, context) => {
        if (accepted || stopped) return Promise.reject(new Error("the session has stopped; tool execution refused"));
        // A stop with no drain runs nothing more; a drain lets a call announced before it run on.
        if (draining && immediate) return Promise.reject(new Error("the session has stopped; this call was not run"));
        if (draining && !announced.has(context.callId)) return Promise.reject(new Error("the session is pausing; this call was not run"));
        return tool.call(args, options.sessionDir ? { ...context, sessionDir: options.sessionDir } : context);
      },
    });


    const spec: SessionSpec = {
      ...node,
      system: [...request.system, 'Only a successful submit tool call delivers the result. Call submit with {"value": YOUR_RESULT}. The schema below describes value, not the envelope.', `Required JSON Schema: ${JSON.stringify(request.schema)}`],
      tools: [...requested.map((name) => guard(registered.get(name)!)), submit],
      context: request.context === "fork" ? "fork" : "fresh",
      ...(request.tier === undefined ? {} : { tier: request.tier }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
    };
    // Refused at create time, before anything is spent: a fork the adapter cannot make, or anything the adapter refuses.
    const problems = [
      ...(spec.context === "fork" ? [`Node "${request.label}" asks for context: "fork", but ${adapter.id} has no caller transcript to fork. Declare context: "fresh".`] : []),
      ...adapter.check(spec),
    ];
    if (problems.length) throw refuse(problems.join("; "));
    const models = booking.models;

    let session: Awaited<ReturnType<AgentAdapter["open"]>> | undefined;
    let opening: Promise<Awaited<ReturnType<AgentAdapter["open"]>>> | undefined;
    // Armed here, with nothing between them and the try whose finally releases them: a refusal above never leaves a timer.
    signals.forEach((s) => s.addEventListener("abort", onAbort, { once: true }));
    // A stop that landed while the store was read: a listener added to an aborted signal never fires.
    if (signals.some((s) => s.aborted)) onAbort();
    const timer = timeoutMs === null ? undefined : setTimeout(() => stop(failure("timeout")), timeoutMs);
    // A pause: nothing new starts, the session drains its calls in flight (an adapter that can't drain stops at once),
    // then the node stops. One that arrived before this node could be paused stops it here.
    pause(async (drainMs) => {
      immediate = drainMs === 0;
      draining = true;
      if (session) await session.interrupt({ drainMs }).catch(() => {});
      stop(failure("aborted"));
    });
    if (halted) {
      draining = true;
      stop(failure("aborted"));
    }
    try {
      if (stopped) throw stopped;
      // A paid request a crash cut off is booked once, as cut, at an unknown price, before this attempt sends anything.
      await bounded(booking.bookCut());
      if (stopped) throw stopped;
      session = await bounded(opening = adapter.open(spec, {
        writer,
        models,
        signal: controller.signal,
        ...(options.sessionDir ? { dir: options.sessionDir(key) } : {}),
        onEvent: (event) => {
          if (event.type === "tool_start") {
            lastTool = event.name.slice(0, 64);
            if (!draining) announced.add(event.callId);
          }
          emit(event);
        },
      }));
      const turnOf = async () => {
        const end = await bounded(session!.turnEnd());
        if (end.status === "failed" && !accepted) stop(failure("model_error", end.error));
      };
      // Sends have their own count, checked against the same limit (or maxSends when it is null), never added to the paid
      // requests: one send may make several. They need no record: a crash restarts them, and the recorded requests still
      // bound the money. Turns that make no paid request also end the node `no_progress` after a few in a row.
      const sendLimit = limit ?? maxSends;
      let sends = 0;
      let idle = 0;
      const progressed = (before: number) => {
        idle = accepted || turnsSoFar() > before ? 0 : idle + 1;
        if (idle >= NO_PROGRESS_TURNS && !accepted) stop(failure("no_progress", `harness node stopped: no_progress, ${idle} turns in a row made no paid request and delivered nothing`));
      };
      if (session.state === "open_turn") {
        const before = turnsSoFar();
        sends += 1;
        await bounded(session.recover());
        await turnOf();
        progressed(before);
      }
      let prompt = session.state === "new" ? request.user : NUDGE;
      while (!accepted && !stopped && !draining && (limit === null || turnsSoFar() < limit) && sends < sendLimit) {
        const before = turnsSoFar();
        sends += 1;
        await bounded(session.send(prompt));
        await turnOf();
        progressed(before);
        prompt = NUDGE;
      }
      if (accepted) return submission;
      if (draining) stop(failure("aborted"));
      if (stopped) throw stopped;
      if (limit !== null && turnsSoFar() >= limit) throw failure("turn_limit");
      // The sends ran out first: say so, since the turns reported are below the limit.
      throw failure("turn_limit", `harness node stopped: turn_limit, ${sends} turns sent (the cap on sends) made ${turnsSoFar()} paid requests and ${submissions} submissions`);
    } catch (error) {
      if (accepted) return submission;
      if (stopped) throw stopped;
      throw error;
    } finally {
      clearTimeout(timer);
      signals.forEach((s) => s.removeEventListener("abort", onAbort));
      if (session) {
        if (!accepted && stopped) await session.interrupt().catch(() => {});
        await session.close().catch(() => {});
      } else if (opening) {
        // The node stopped while its session was opening: a session that opens later is stopped and let go, so no harness
        // process outlives the node.
        void opening.then(async (late) => {
          await late.interrupt().catch(() => {});
          await late.close().catch(() => {});
        }, () => {});
      }
    }
  };

  const run = (request: NodeRequest): Promise<unknown> => {
    let drain = async (_drainMs: number) => {};
    const node = runNode(request, (pause) => { drain = pause; });
    running.set(node, (drainMs) => drain(drainMs));
    void node.then(() => running.delete(node), () => running.delete(node));
    return node;
  };
  return Object.assign(run, {
    async stop(stopOptions: { drainMs?: number } = {}) {
      const drainMs = stopOptions.drainMs ?? 0;
      if (!Number.isFinite(drainMs) || drainMs < 0) throw new Error("drainMs must be a non-negative number of milliseconds");
      halted = true;
      const nodes = [...running];
      await Promise.all(nodes.map(([, drain]) => drain(drainMs)));
      await Promise.allSettled(nodes.map(([node]) => node));
    },
  });
}
