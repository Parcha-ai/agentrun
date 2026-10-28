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
import { HarnessRunError, SessionFenced } from "./errors.js";
import type { AdapterEvent, AgentAdapter, HarnessEvent, HostTool, ModelPort, ModelUsage, NodeRequest, SessionRecord, SessionSpec, SessionStore, SessionWriter } from "./types.js";

export type HarnessRunner = (request: NodeRequest) => Promise<unknown>;

/** The tool the runner injects; a host tool may not take its name. */
export const SUBMIT_TOOL = "submit";
/** The records the runner keeps beside the adapter's own, in each session. */
/** `request` is written before a paid request leaves, `turn` when it has answered with its usage: a request a crash cut off
 *  keeps its `request` and has no `turn`. */
export const RUNNER_RECORDS = { request: "runner.request", turn: "runner.turn", submit: "runner.submit", accepted: "runner.accepted" } as const;

/** What the host is asked before each paid request. A `refuse` ends the node, final. */
export type BeforeRequest = (request: {
  key: string; label: string; executionPath?: string; model: string;
  /** The turn this request would be, counting from 1; `maxTurns` is the node's limit. */
  turn: number; maxTurns: number | null;
  /** The node's `budget_usd`, if it set one, and what its session has spent so far (null when a price was unknown). */
  budgetUsd?: number; spentUsd: number | null;
}) => void | { refuse: string } | Promise<void | { refuse: string }>;

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
  /** Every event, with the node it belongs to. */
  onEvent?: (event: HarnessEvent) => void;
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
  onEvent?: (event: ModelPortEvent & { key: string; label: string; executionPath?: string }) => void;
  /** The session's records, as already read (default: read from the writer). */
  records?: readonly SessionRecord[];
  /** How a record is written (default: the writer's append, which a newer open fences). */
  append?: (records: SessionRecord[]) => Promise<void>;
  /** The attempt has stopped: the error a new paid request is refused with. */
  stopped?: () => Error | undefined;
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
  // off still counts against the turn cap. What it cost is unknown, so the session's spend is too from then on.
  let turns = options.records.filter((r) => r.kind === RUNNER_RECORDS.request).length;
  const booked = options.records.filter((r) => r.kind === RUNNER_RECORDS.turn);
  let answered = booked.length;
  let spentUsd: number | null = answered < turns ? null : booked.reduce<number | null>((sum, r) => {
    const usd = (r.data as { usd?: number | null }).usd;
    return sum === null || usd === null ? null : sum + (usd ?? 0);
  }, 0);
  const end = (reason: "turn_limit" | "refused" | "model_error", message?: string): Error =>
    options.stop ? options.stop(reason, message) : new HarnessRunError(reason, turns, 0, { maxTurns: limit, ...(message === undefined ? {} : { message }) });
  const models: ModelPort = {
    beforeRequest: async ({ model }: { model: string }) => {
      const stopped = options.stopped?.();
      if (stopped) throw stopped;
      if (limit !== null && turns >= limit) throw end("turn_limit");
      const verdict = await options.beforeRequest?.({ ...node, model, turn: turns + 1, maxTurns: limit, ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }), spentUsd });
      if (verdict && "refuse" in verdict) throw end("refused", verdict.refuse);
      // Durable before the request leaves: admitted, then sent.
      await append([{ kind: RUNNER_RECORDS.request, data: { turn: turns + 1, model } }]);
      turns += 1;
      emit({ type: "request_start", turn: turns, model });
    },
    afterRequest: async (usage: ModelUsage) => {
      spentUsd = spentUsd === null || usage.usd === null ? null : spentUsd + usage.usd;
      try {
        await append([{ kind: RUNNER_RECORDS.turn, data: { usd: usage.usd } }]);
      } catch (error) {
        // A paid request whose cost can't be kept: the attempt stops, saying so, rather than spend on uncounted.
        if (!options.stopped?.()) end("model_error", `harness node stopped: the cost of a paid request could not be recorded: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
        throw error;
      }
      answered += 1;
      emit({ type: "request_end", turn: turns, usage });
    },
  };
  return {
    models,
    turns: () => turns,
    spentUsd: () => spentUsd,
    async bookCut() {
      // A paid request a crash cut off kept its runner.request and has no runner.turn: the provider may have billed it.
      // Each is booked once, as cut, at an unknown price, and the host is told as for any answered request, so its ledger
      // shows the possible spend instead of nothing. Booked, it is answered: a later attempt never books it again.
      const unanswered = turns - answered;
      if (unanswered <= 0) return;
      const cut: ModelUsage = { input: 0, output: 0, cacheRead: 0, usd: null, estimated: true, cut: true };
      const numbers = Array.from({ length: unanswered }, (_, i) => answered + i + 1);
      await append(numbers.map((turn) => ({ kind: RUNNER_RECORDS.turn, data: { usd: null, cut: true, turn } })));
      answered = turns;
      spentUsd = null;
      for (const turn of numbers) emit({ type: "request_end", turn, usage: cut });
    },
  };
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

  return async (request) => {
    // Without a step there is no durable identity: a fresh session of the runner's own, never one derived from the
    // label, which map items and loops repeat.
    const key = request.step ? `step:${request.step.sessionId}` : `call:${randomUUID()}`;
    const node = { key, label: request.label, ...(request.executionPath === undefined ? {} : { executionPath: request.executionPath }) };
    const emit = (event: AdapterEvent | { type: "request_start"; turn: number; model: string } | { type: "request_end"; turn: number; usage: ModelUsage }) => options.onEvent?.({ ...event, ...node } as HarnessEvent);
    const refuse = (message: string, turns = 0, submissions = 0) => new HarnessRunError("refused", turns, submissions, { message });

    const signals = [options.signal, request.signal].filter((s): s is AbortSignal => Boolean(s));
    if (signals.some((s) => s.aborted)) throw new HarnessRunError("aborted", 0, 0);
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
      stop: (reason, message) => { stop(failure(reason, message)); return stopped!; },
    });

    const submit: HostTool = {
      name: SUBMIT_TOOL,
      description: "Deliver a result matching the required JSON Schema. Rejection feedback must be corrected in this session.",
      inputSchema: parameters,
      replay: "safe",
      async call(args) {
        if (accepted) return { text: "Already accepted; end your turn." };
        if (stopped) return { text: "This session has stopped.", isError: true };
        submissions += 1;
        await append([{ kind: RUNNER_RECORDS.submit, data: { n: submissions } }]);
        const candidate = (args as { value?: unknown } | null)?.value;
        let message: string | undefined;
        if (!envelope.Check(args)) message = JSON.stringify([...envelope.Errors(args)]);
        else if (!validator.Check(candidate)) message = JSON.stringify([...validator.Errors(candidate)]);
        else if (request.review) {
          const verdict = await request.review(candidate);
          if (!verdict.accepted) message = verdict.message;
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
        return tool.call(args, context);
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
    try {
      if (stopped) throw stopped;
      // A paid request a crash cut off is booked once, as cut, at an unknown price, before this attempt sends anything.
      await booking.bookCut();
      session = await bounded(opening = adapter.open(spec, {
        writer,
        models,
        signal: controller.signal,
        ...(options.sessionDir ? { dir: options.sessionDir(key) } : {}),
        onEvent: (event) => {
          if (event.type === "tool_start") lastTool = event.name.slice(0, 64);
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
      while (!accepted && !stopped && (limit === null || turnsSoFar() < limit) && sends < sendLimit) {
        const before = turnsSoFar();
        sends += 1;
        await bounded(session.send(prompt));
        await turnOf();
        progressed(before);
        prompt = NUDGE;
      }
      if (accepted) return submission;
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
}
