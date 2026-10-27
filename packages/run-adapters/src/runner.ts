// A DSL node on any harness: createHarnessRunner turns an AgentAdapter into exactly the interpreter's `runNode`, so a
// DSL host and serve run a node on Codex, OpenCode or the Claude Agent SDK the way createPiRunner runs it on Pi. The
// node's record arrives through an injected `submit` tool whose input is the node's schema under `value`
// (submitParameters, the envelope both runners use); a review that does not accept it is the tool's result, in the
// same session. Every paid request passes the runner first: the turn cap, then the host's `beforeRequest` (its budget),
// each of which may refuse it. Under recovery a session is keyed by its step's sessionId: a delivered record is answered
// from the session's records, and a session cut off inside a turn is resumed by the adapter, spending nothing again.
import { randomUUID } from "node:crypto";
import { Compile } from "typebox/compile";
import { submitParameters } from "@parcha/agentrun-dsl";
import { HarnessRunError } from "./errors.js";
import type { AdapterEvent, AgentAdapter, HarnessEvent, HostTool, ModelUsage, NodeRequest, SessionRecord, SessionSpec, SessionStore } from "./types.js";

export type HarnessRunner = (request: NodeRequest) => Promise<unknown>;

/** The tool the runner injects; a host tool may not take its name. */
export const SUBMIT_TOOL = "submit";
/** The records the runner keeps beside the adapter's own, in each session. */
export const RUNNER_RECORDS = { turn: "runner.turn", submit: "runner.submit", accepted: "runner.accepted" } as const;

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

const NUDGE = "You finished without an accepted submission. Call submit with the complete result; plain text does not deliver it.";

export function createHarnessRunner(adapter: AgentAdapter, options: HarnessRunnerOptions): HarnessRunner {
  const maxTurns = options.maxTurns === null ? null : positive(options.maxTurns ?? 8, "maxTurns");
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

    // A session that already delivered: its record, and nothing runs.
    const earlier = request.step ? await store.read(key) : [];
    const delivered = earlier.findLast((r) => r.kind === RUNNER_RECORDS.accepted);
    if (delivered) return structuredClone((delivered.data as { value: unknown }).value);

    const validator = Compile(request.schema as never);
    const parameters = submitParameters(request.schema);
    const envelope = Compile(parameters as never);
    let turns = earlier.filter((r) => r.kind === RUNNER_RECORDS.turn).length;
    let submissions = earlier.filter((r) => r.kind === RUNNER_RECORDS.submit).length;
    let spentUsd: number | null = earlier.filter((r) => r.kind === RUNNER_RECORDS.turn).reduce<number | null>((sum, r) => {
      const usd = (r.data as { usd?: number | null }).usd;
      return sum === null || usd === null ? null : sum + (usd ?? 0);
    }, 0);
    let accepted = false;
    let submission: unknown;
    let lastTool: string | undefined;
    let stopped: HarnessRunError | undefined;
    const failure = (reason: HarnessRunError["reason"], message?: string) =>
      new HarnessRunError(reason, turns, submissions, { maxTurns: limit, ...(lastTool === undefined ? {} : { lastTool }), ...(message === undefined ? {} : { message }) });

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
    const append = (records: SessionRecord[]) => store.append(key, records);

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
    const models = {
      beforeRequest: async ({ model }: { model: string }) => {
        if (stopped) throw stopped;
        if (limit !== null && turns >= limit) {
          stop(failure("turn_limit"));
          throw stopped;
        }
        const verdict = await options.beforeRequest?.({ ...node, model, turn: turns + 1, maxTurns: limit, ...(request.budgetUsd === undefined ? {} : { budgetUsd: request.budgetUsd }), spentUsd });
        if (verdict && "refuse" in verdict) {
          stop(failure("refused", verdict.refuse));
          throw stopped;
        }
        turns += 1;
        emit({ type: "request_start", turn: turns, model });
      },
      afterRequest: async (usage: ModelUsage) => {
        spentUsd = spentUsd === null || usage.usd === null ? null : spentUsd + usage.usd;
        await append([{ kind: RUNNER_RECORDS.turn, data: { usd: usage.usd } }]);
        emit({ type: "request_end", turn: turns, usage });
      },
    };

    let session: Awaited<ReturnType<AgentAdapter["open"]>> | undefined;
    // Armed here, with nothing between them and the try whose finally releases them: a refusal above never leaves a timer.
    signals.forEach((s) => s.addEventListener("abort", onAbort, { once: true }));
    const timer = timeoutMs === null ? undefined : setTimeout(() => stop(failure("timeout")), timeoutMs);
    try {
      session = await bounded(adapter.open(spec, {
        store,
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
      if (session.state === "open_turn") {
        await bounded(session.recover());
        await turnOf();
      }
      let prompt = session.state === "new" ? request.user : NUDGE;
      while (!accepted && !stopped && (limit === null || turns < limit)) {
        await bounded(session.send(prompt));
        await turnOf();
        prompt = NUDGE;
      }
      if (accepted) return submission;
      if (stopped) throw stopped;
      throw failure("turn_limit");
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
      }
    }
  };
}
