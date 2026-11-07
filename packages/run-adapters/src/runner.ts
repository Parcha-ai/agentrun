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
import type { AdapterEvent, AgentAdapter, HarnessEvent, HostTool, ModelPort, ModelRequest, ModelTicket, ModelUsage, NodeRequest, NoteRequest, SessionRecord, SessionSpec, SessionStore, SessionWriter } from "./types.js";

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
  /** On another model than the session's (ModelRequest.side): a client's side call. */
  side?: true;
  /** It carries the host's note (ModelRequest.noted), and its input measured without it (`inputTokensMaxWithoutNote`):
   *  a host that admits it only without the note says so (Admission.withoutNote). */
  noted?: true;
  inputTokensMaxWithoutNote?: number;
  /** This session's paid requests admitted and not yet answered (in this process), oldest first, each with its own
   *  `inputTokensMax`, the output limit it was admitted with (`outputTokensMax`) and what its host held for it
   *  (`holdUsd`): a budget holds each one until it answers, since `spentUsd` counts answered requests only. Requests are
   *  admitted one at a time, so each check sees every request admitted before it. */
  inFlight: readonly InFlight[];
}) => void | { refuse: string } | Admission | Promise<void | { refuse: string } | Admission>;

/** A request admitted and not yet answered, as a budget holds it: at what its host held for it (`holdUsd`), when it held
 *  one. */
export type InFlight = { turn: number; model: string; inputTokensMax?: number; outputTokensMax?: number; holdUsd?: number };
/** A host's admission: what it holds for the request (`holdUsd`), and the most output tokens, thinking included, it may
 *  be sent with (`outputTokensMax`, what is left of a cap can buy), which its ticket carries to the model proxy. A
 *  request its client stops part way (`ModelUsage.stoppedAfterBytes`), its cost unknown, counts at `stoppedUsd` of what
 *  streamed, in tokens (one a byte), never more than `holdUsd`; without it, at `holdUsd`. `withoutNote`: a request that
 *  carries its host's note is admitted only as it was without it (the note's bytes did not fit): it goes without it. */
export type Admission = { holdUsd?: number; outputTokensMax?: number; stoppedUsd?: (streamedTokens: number) => number; withoutNote?: true };

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

/** What a paid request tells a host, beside its session's key and label. */
export type ModelPortEvent = { type: "request_start"; turn: number; model: string } | { type: "request_end"; turn: number; usage: ModelUsage };

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
  /** How a record is written (default: the writer's append, which a newer open fences). */
  append?: (records: SessionRecord[]) => Promise<void>;
  /** The attempt has stopped: the error a new paid request is refused with. A `TurnParked` refuses new requests but is no
   *  stop of the booking: a paid request whose cost can't be recorded meanwhile still stops it. */
  stopped?: () => Error | undefined;
  /** A pause is draining the attempt: the error a new paid request is refused with, while the attempt itself goes on. A
   *  request is refused if the pause began before its record is written, even while the host's check of it was running. */
  draining?: () => Error | undefined;
  /** A note the host has for the session's next main-model request, taken by the call (ModelPort.note). */
  note?: (model: string, request?: NoteRequest) => string | undefined;
  /** The port ends the attempt (the turn limit, the host's refusal, a cost it could not record): the error it throws. */
  stop?: (reason: "turn_limit" | "refused" | "model_error", message?: string) => Error;
}

/** A session's booking of paid model requests: the adapter's model port, and what it has counted. */
export interface ModelBooking {
  /** The port the adapter's session reports every paid request to (`SessionIO.models`). */
  readonly models: ModelPort;
  /** Paid requests that left in this session, one a crash cut off included. */
  turns(): number;
  /** What they cost; null once one's price is unknown. */
  spentUsd(): number | null;
  /** Books, once, each paid request a crash cut off (a `runner.request` with no `runner.turn`): a `runner.turn` marked
   *  `cut` at an unknown price, and a `request_end` saying so. A booked request is answered, so this is idempotent.
   *  Call it before the session sends anything. */
  bookCut(): Promise<void>;
}

/** The runner's booking of paid model requests, for a host that drives an adapter session itself (a chat run): the same
 *  records (`runner.request` before a request leaves, `runner.turn` with its cost when it answers), the same turn limit
 *  and `beforeRequest`, the same events. `createHarnessRunner` is built on it. */
export async function modelPortFor(writer: SessionWriter, options: ModelPortOptions): Promise<ModelBooking> {
  return bookingFor(writer, { ...options, records: options.records ?? (await writer.read()) });
}

function bookingFor(writer: SessionWriter, options: ModelPortOptions & { records: readonly SessionRecord[] }): ModelBooking {
  const node = { key: options.key, label: options.label ?? options.key, ...(options.executionPath === undefined ? {} : { executionPath: options.executionPath }) };
  const limit = options.maxTurns ?? null;
  const append = options.append ?? ((records: SessionRecord[]) => writer.append(records));
  const emit = (event: ModelPortEvent) => options.onEvent?.({ ...event, ...node });
  // A turn is a paid request that left: counted from the records written before each one left, so a request a crash cut
  // off still counts against the turn cap. What it cost is unknown: the session's spend counts it at the figure its
  // host held for it, on its record, and is unknown from then on when there is none.
  const requests = options.records.filter((r) => r.kind === RUNNER_RECORDS.request).map((r) => (r.data ?? {}) as { turn?: number; heldUsd?: unknown });
  const inherited = requests.map((data, i) => data.turn ?? i + 1);
  let turns = inherited.length;
  /** What the host held for each request, by turn: what it counts at when its own cost never comes in. */
  const held = new Map<number, number>();
  /** What the host counts each request of this process at if its client stops it part way (Admission.stoppedUsd). */
  const stoppedAt = new Map<number, (streamedTokens: number) => number>();
  requests.forEach((data, i) => {
    const figure = heldFigure(data.heldUsd);
    if (figure !== undefined) held.set(inherited[i]!, figure);
  });
  // Which of them were answered: each runner.turn names its own turn (one written before turns were named answers the
  // earliest still open, as answers then came in order).
  const answered = new Set<number>();
  let spentUsd: number | null = 0;
  for (const r of options.records) {
    if (r.kind !== RUNNER_RECORDS.turn) continue;
    const data = r.data as { turn?: number; usd?: number | null; heldUsd?: unknown; bookedUsd?: unknown };
    const turn = data.turn ?? inherited.find((t) => !answered.has(t)) ?? 0;
    answered.add(turn);
    // The figure it was booked at (bookRequest), as written. A record from before that has none: a cost that never came
    // in at the figure its answer was booked at (a stopped request's), else what was held for it.
    const booked = data.bookedUsd === null ? null : heldFigure(data.bookedUsd);
    spentUsd = spent(spentUsd, booked !== undefined ? (booked ?? undefined) : data.usd === null ? (heldFigure(data.heldUsd) ?? held.get(turn)) : (data.usd ?? 0));
  }
  for (const turn of inherited) if (!answered.has(turn)) spentUsd = spent(spentUsd, held.get(turn));
  // The ids each request's response gave it, kept as its headers arrived: a request cut off after them reached the provider.
  const responses = new Map<number, Record<string, string>>();
  for (const r of options.records) {
    if (r.kind !== RUNNER_RECORDS.response) continue;
    const data = r.data as { turn?: number; providerIds?: Record<string, string> };
    if (typeof data.turn === "number" && data.providerIds) responses.set(data.turn, data.providerIds);
  }
  // This process's requests in flight, oldest first: the turn each was admitted as, and its model.
  const open: InFlight[] = [];
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
  const end = (reason: "turn_limit" | "refused" | "model_error", message?: string): Error =>
    options.stop ? options.stop(reason, message) : new HarnessRunError(reason, turns, 0, { maxTurns: limit, ...(message === undefined ? {} : { message }) });
  const admit = async ({ model, inputTokensMax: measured, outputTokensAsked, outputTokensLeast, side, noted, inputTokensMaxWithoutNote }: ModelRequest): Promise<ModelTicket> => {
    let inputTokensMax = measured;
    const stopped = options.stopped?.() ?? failed;
    if (stopped) throw stopped;
    const pausing = options.draining?.();
    if (pausing) throw pausing;
    if (limit !== null && turns >= limit) throw end("turn_limit");
    const verdict = await options.beforeRequest?.({ ...node, model, turn: turns + 1, maxTurns: limit, ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }), spentUsd, inFlight: open.map((f) => ({ ...f })), inputTokensMax,
      ...(outputTokensAsked === undefined ? {} : { outputTokensAsked }), ...(outputTokensLeast === undefined ? {} : { outputTokensLeast }), ...(side ? { side } : {}), ...(noted ? { noted, ...(inputTokensMaxWithoutNote === undefined ? {} : { inputTokensMaxWithoutNote }) } : {}) });
    if (verdict && "refuse" in verdict) throw end("refused", verdict.refuse);
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
    const late = options.stopped?.() ?? failed ?? options.draining?.();
    if (late) throw late;
    // Durable before the request leaves: admitted, then sent. It counts as a turn once its record is written (admissions
    // run one at a time), so a write that fails refuses the request and costs no turn.
    const turn = turns + 1;
    await write([{ kind: RUNNER_RECORDS.request, data: { turn, model, ...(hold === undefined ? {} : { heldUsd: hold }), ...(side ? { side } : {}) } }]);
    turns = turn;
    if (hold !== undefined) held.set(turn, hold);
    const stoppedUsd = verdict && "stoppedUsd" in verdict && typeof verdict.stoppedUsd === "function" ? verdict.stoppedUsd : undefined;
    if (stoppedUsd) stoppedAt.set(turn, stoppedUsd);
    // A stop that came while the record was written: the request has not left. It is booked withdrawn, at $0, so no
    // later process books it as cut at an unknown price; if that write fails, it is booked cut, which is never less.
    // Its record is written, so it costs a turn of the cap, never money.
    const stoppedNow = options.stopped?.();
    if (stoppedNow) {
      answered.add(turn);
      // Through the booking's own write: a response's ids still waiting to be carried go with the withdrawal.
      await write([{ kind: RUNNER_RECORDS.turn, data: { turn, usd: 0, unsent: true } }]).catch(() => undefined);
      throw stoppedNow;
    }
    // The host's start mark, awaited before the request leaves (its handler commits and syncs it). One it refuses is
    // booked as a stop is, withdrawn at $0, and the request never joins the open ones, which a ticketless answer reads.
    try {
      await emit({ type: "request_start", turn, model });
    } catch (error) {
      answered.add(turn);
      await write([{ kind: RUNNER_RECORDS.turn, data: { turn, usd: 0, unsent: true } }]).catch(() => undefined);
      throw error;
    }
    // A stop that came while the mark was made: the request has not left either. Booked withdrawn as above, and its end
    // told to the host, whose mark has it started: at $0, so the host never reads it cut at an unknown price.
    const stoppedLate = options.stopped?.();
    if (stoppedLate) {
      answered.add(turn);
      await write([{ kind: RUNNER_RECORDS.turn, data: { turn, usd: 0, unsent: true } }]).catch(() => undefined);
      emit({ type: "request_end", turn, usage: { input: 0, output: 0, cacheRead: 0, usd: 0 } });
      throw stoppedLate;
    }
    open.push({ turn, model, inputTokensMax, ...(limited === undefined ? {} : { outputTokensMax: limited }), ...(hold === undefined ? {} : { holdUsd: hold }) });
    return { turn, ...(limited === undefined ? {} : { outputTokensMax: limited }), ...(withoutNote ? { noteDropped: true as const } : {}) };
  };
  const models: ModelPort = {
    ...(options.note ? { note: options.note } : {}),
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
      if (at >= 0) open.splice(at, 1);
      // A cost that never came in (a response cut short): at what the host held for the request, else unknown. One its
      // client stopped part way at what the host counts it at by what streamed (one token a byte), never more than that.
      const hold = held.get(turn);
      const stoppedUsd = stoppedAt.get(turn);
      stoppedAt.delete(turn);
      // Its hidden reasoning counts beside all it sent, less the reasoning it sent: max(0, budget - reasoning bytes), so
      // reasoning that streamed is not counted twice and answer text never stands in for it.
      const figure0 = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
      const hidden = figure0(usage.stoppedHiddenTokens);
      const reasoned = figure0(usage.stoppedReasoningBytes);
      const sent = typeof usage.stoppedAfterBytes === "number" && usage.stoppedAfterBytes >= 0 ? usage.stoppedAfterBytes : undefined;
      const stopped = usage.usd === null && hold !== undefined && stoppedUsd && sent !== undefined ? heldFigure(stoppedUsd(sent + Math.max(0, hidden - reasoned))) : undefined;
      // How its path saw it end, booked by the one rule (booking.ts); a host from before that says nothing of it: as
      // before, its own cost, else what streamed of a stop, else the hold.
      const booking = ended ? bookRequest(ended, { ...(hold === undefined ? {} : { hold }), ...(stoppedUsd ? { stoppedPrice: stoppedUsd } : {}) }) : undefined;
      const figure = booking ? booking.usd : usage.usd !== null ? usage.usd : stopped === undefined ? hold : Math.min(hold!, stopped);
      spentUsd = spent(spentUsd, figure ?? undefined);
      try {
        // A runner.turn with the ids holds what a carried response record of this turn would: that one is dropped. A
        // stopped one keeps the figure it counts at (`heldUsd`), so a later process counts it the same.
        const covers = (r: SessionRecord) => usage.providerIds !== undefined && (r.data as { turn?: number }).turn === turn;
        await write([{ kind: RUNNER_RECORDS.turn, data: { turn, usd: usage.usd, ...tokensOf(usage), ...(usage.estimated ? { estimated: true } : {}), ...(usage.tableUsd === undefined ? {} : { tableUsd: usage.tableUsd }), ...(usage.providerIds ? { providerIds: usage.providerIds } : {}), ...(stopped === undefined ? {} : { heldUsd: Math.min(hold!, stopped), stopped: true }), ...(booking ? { bookedUsd: booking.usd, rule: booking.rule } : {}) } }], covers);
      } catch (error) {
        // A paid request whose cost can't be kept: the attempt stops, saying so, rather than spend on uncounted. A turn
        // parked on a call (TurnParked) is no stop of the booking, so it stops here too; a stop that ended it already wins.
        const stop = options.stopped?.();
        if (!stop || stop instanceof TurnParked) failed ??= end("model_error", `harness node stopped: the cost of a paid request could not be recorded: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
        throw error;
      }
      answered.add(turn);
      emit({ type: "request_end", turn, usage });
    },
  };
  // One booking of the cut requests at a time: a call made while one is writing waits for it, never books them again.
  let cutting: Promise<void> | undefined;
  const bookCut = async () => {
    // A paid request a crash cut off kept its runner.request and has no runner.turn: the provider may have billed it.
    // Each is booked once, as cut, at an unknown price, and the host is told as for any answered request, so its ledger
    // shows the possible spend instead of nothing. Booked, it is answered: a later attempt never books it again.
    // Only requests an earlier process admitted: one this process has in flight is not cut.
    const numbers = inherited.filter((t) => !answered.has(t));
    if (numbers.length === 0) return;
    // A cut request whose response had begun carries the ids it gave: the provider saw it, under them. One with none may
    // still have reached the provider before any answer; both are booked at an unknown price.
    const cutOf = (turn: number): SessionRecord["data"] => {
      const providerIds = responses.get(turn);
      return providerIds ? { usd: null, cut: true, turn, providerIds } : { usd: null, cut: true, turn };
    };
    await append(numbers.map((turn) => ({ kind: RUNNER_RECORDS.turn, data: cutOf(turn) })));
    for (const turn of numbers) answered.add(turn);
    // The spend already counts each of them, at its held figure or as unknown: booking them adds nothing.
    for (const turn of numbers) {
      const providerIds = responses.get(turn);
      emit({ type: "request_end", turn, usage: { input: 0, output: 0, cacheRead: 0, usd: null, estimated: true, cut: true, ...(providerIds ? { providerIds } : {}) } });
    }
  };
  return {
    models,
    turns: () => turns,
    spentUsd: () => spentUsd,
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
    const emit = (event: AdapterEvent | { type: "request_start"; turn: number; model: string } | { type: "request_end"; turn: number; usage: ModelUsage }) => options.onEvent?.({ ...event, ...node } as HarnessEvent);
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
    const failure = (reason: HarnessRunError["reason"], message?: string) =>
      new HarnessRunError(reason, turnsSoFar(), submissions, { maxTurns: limit, ...(lastTool === undefined ? {} : { lastTool }), ...(message === undefined ? {} : { message }) });

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
      stop: (reason, message) => { stop(failure(reason, message)); return stopped!; },
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
      ...(spec.context === "fork" && !adapter.capabilities().fork ? [`Node "${request.label}" asks for context: "fork", but ${adapter.id} has no caller transcript to fork. Declare context: "fresh".`] : []),
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
