// The kernel's loop for any harness on the adapter contract (AgentAdapter: claude-agent, codex, opencode, and pi through
// runner/adapters/pi.ts): one claimed run, one Harness on the claim's journal (behind the loop's Gate), one session.
// What the loop owns, the same for every harness:
// - the claim and its journal: every commit the loop stages is matched to the commit that carries it (Gate);
// - the run's end: an `agentrun.end` entry with the run row's patch (ended, stopped with why, failed with why) and a
//   stop's take; a park (an ask with the run parked); an interrupt on a lost claim or a shutdown (nothing more written;
//   the session ended with the adapter's interrupt() and then close(), the path a CLI adapter's kill rides);
// - a restart of the Session on the kernel's own fault between a call and its result, under a finite restart limit;
// - the gate before a call's intent (io.gate: the kernel's beforeIntent point, then allow, deny or ask), and the rule
//   before a side effect around every host tool (side-effects.ts: a flush unless the tool is replay-safe, the call, the
//   beforeResult point), on the host-tool path every adapter's calls take;
// - the paid model requests: the runner's booking (modelPortFor), the one ledger, every request through it;
// - the held state (pi.live) reported through deps.live; the commands (steer, approve, deny).
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type Conversation, type ConversationId, createRegistry, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { type AdapterSession, type AgentAdapter, type BeforeRequest, type HostTool, modelPortFor, type SessionSpec } from "@parcha/agentrun-kernel";
import type { KernelHooks, ToolCall } from "./conformance/subject.js";
import { type AnswerData, type AskData, type EndData, KINDS } from "./journal-kinds.js";
import type { Claim, Command, CommandOutcome, Loop, LoopDeps, LoopEnd, LoopFactory, StopReason } from "./loop-contract.js";
import { approvalOf, CLOSE_MS, commandRequest, DEFAULT_RESTART_LIMIT, entriesOf, findData, Gate, heldReporter, Interrupted, KernelFault, Parked, quiet, restartLimited, writesEntry, writesSubmission } from "./loop.js";
import type { PiRun, PiSessionIO, PreIntentAnswer, PreIntentCall } from "./adapters/pi.js";
import { journalSessions } from "./sessions.js";
import { sideEffect } from "./side-effects.js";

/** What one claimed run's adapter loop runs. */
export interface AdapterRunSpec {
  readonly adapter: AgentAdapter;
  readonly session: SessionSpec;
  /** The person's first message, sent once, on the run's first claim. */
  readonly input: string;
  readonly hooks?: KernelHooks;
  /** The gate's answer for a call, before its intent: run it, refuse it, or ask a person (the run parks). */
  readonly gate?: (call: ToolCall) => "allow" | "ask" | "deny";
  /** The host's check before each paid request (the spend cap). */
  readonly beforeRequest?: BeforeRequest;
}

/** What the loop lends the spec for one Session: the run's Harness (pi adds its turns to it). */
export type AdapterRun = PiRun;

export interface AdapterLoopOptions {
  /** How many times pi restarts a call's task cut off without progress before it ends it (restart_limit); finite.
   *  Default DEFAULT_RESTART_LIMIT. */
  readonly restartLimit?: number;
}

/** Loops for runs on the adapter contract: `spec(claim, run)` gives each Session what it runs. */
export function createAdapterLoop(spec: (claim: Claim, run: AdapterRun) => AdapterRunSpec | Promise<AdapterRunSpec>, options: AdapterLoopOptions = {}): LoopFactory {
  return (deps) => adapterLoop(spec, options, deps);
}

function adapterLoop(specOf: (claim: Claim, run: AdapterRun) => AdapterRunSpec | Promise<AdapterRunSpec>, options: AdapterLoopOptions, deps: LoopDeps): Loop {
  const restartLimit = options.restartLimit ?? DEFAULT_RESTART_LIMIT;
  const inbox: Command[] = [];
  let wakeInbox: () => void = () => {};
  let stopReason: StopReason | undefined;
  let stopped: () => void = () => {};
  const stopping = new Promise<void>((resolve) => (stopped = resolve));
  let parked: () => void = () => {};
  const parking = new Promise<void>((resolve) => (parked = resolve));
  let finished: Promise<LoopEnd> | undefined;
  let gate: Gate | undefined;
  let harness: Harness | undefined;
  let root: Conversation | undefined;
  let session: AdapterSession | undefined;
  let context: Context = BACKGROUND_CONTEXT;
  const early: Command[] = [];
  /** Approve or deny rows refused because they named no call waiting for its answer. */
  let refusals = 0;
  /** Resolved once the claim's Harness is open and its root known: a command's check reads the journal through it. */
  let opened: () => void = () => {};
  const ready = new Promise<void>((resolve) => (opened = resolve));
  let held: { detach(): void } | undefined;

  const steer = async (command: Command): Promise<CommandOutcome> => {
    if (!gate || !session) {
      early.push(command);
      return { taken: true };
    }
    if (!session.steer) return { refused: "this harness takes no steer mid-turn" };
    const text = typeof (command.body as { text?: unknown } | null)?.text === "string" ? (command.body as { text: string }).text : "";
    const requestId = commandRequest(command.id);
    const taken = gate.expect(writesSubmission(requestId), { take: [command.id] });
    try {
      await session.steer(text, requestId);
    } catch (error) {
      taken.catch(() => {});
      return { refused: `the steer was not placed: ${(error as Error).message}` };
    }
    await taken.catch(() => {});
    return { taken: true };
  };

  async function run(claim: Claim): Promise<LoopEnd> {
    context = withAbortSignal(deps.signal, BACKGROUND_CONTEXT);
    const signalAbort = () => gate?.seal(new Interrupted("its claim's signal aborted"));
    deps.signal.addEventListener("abort", signalAbort, { once: true });
    let fault: KernelFault | undefined;
    try {
      for (let restarts = 0; ; restarts += 1) {
        fault = undefined;
        gate = new Gate(deps.journal(claim));
        if (deps.signal.aborted) gate.seal(new Interrupted("its claim's signal aborted"));
        const registry = createRegistry();
        let models: Models = createModels();
        harness = await Harness.open(gate.journal, { models: () => models, registry, settings: { restartLimit }, onReport: () => {} }, context);
        const runOf: AdapterRun = { harness, registry, setModels: (given) => (models = given) };
        const spec = await specOf(claim, runOf);
        const hooks = spec.hooks ?? quiet;
        const sessions = journalSessions(harness, context, { flush: () => deps.flush() });
        const writer = await sessions.open(spec.session.key);
        // The rule before a side effect for every paid model request, on the path every adapter's requests take: the
        // booking writes the request's record, then awaits request_start before the request leaves, so the flush here
        // makes that record and everything before it durable first (each send, a retry's included).
        const booking = await modelPortFor(writer, {
          key: spec.session.key,
          label: spec.session.label,
          ...(spec.beforeRequest ? { beforeRequest: spec.beforeRequest } : {}),
          onEvent: async (event) => {
            if (event.type === "request_start") await deps.flush();
          },
        });
        const gateOf = preIntentGate(spec, hooks);
        const tools: HostTool[] = spec.session.tools.map((tool) => ({
          ...tool,
          // The rule before a side effect, on the host-tool path every adapter's calls take: after the call's intent, a
          // flush unless the tool is replay-safe, the call, then the beforeResult point. A throw there is the kernel's own
          // fault: the journal is sealed before the harness's result commit, so the Session fails with the call before
          // its result, and the loop restarts it.
          call: (args, toolContext) =>
            sideEffect({
              replaySafe: tool.replay === "safe",
              flush: () => deps.flush(),
              route: () => tool.call(args, toolContext),
              beforeResult: async (answer) => {
                const call: ToolCall = { callId: toolContext.callId, tool: tool.name as never, args: (args ?? {}) as Record<string, unknown> };
                try {
                  await hooks.beforeResult(call, answer.text);
                } catch (error) {
                  fault = new KernelFault(call, error);
                  gate!.seal(fault);
                  throw fault;
                }
              },
            }),
        }));
        const io: PiSessionIO = { writer, models: booking.models, signal: deps.signal, onEvent: () => {}, gate: gateOf };
        session = await spec.adapter.open({ ...spec.session, tools }, io);
        root = await harness.root(context);
        opened();
        await reportHeld(harness, root.id);
        for (const command of early.splice(0)) void steer(command);
        if (restarts > restartLimit + 1) {
          return await writeEnd(harness, root, gate, { state: "failed", summary: `the kernel faulted on every restart (${restarts} restarts)` }, []);
        }
        if (session!.state === "new") await session!.send(spec.input);
        else if (session!.state === "open_turn") await session!.recover();
        const turn = session!.state === "idle" ? Promise.resolve({ status: "completed" as const }) : session!.turnEnd();
        const end = await Promise.race([turn.then(() => "answered" as const), parking.then(() => "parked" as const), stopping.then(() => "stop" as const), harness.closed.then(() => "closed" as const)]);
        if (end === "parked") {
          gate.seal(new Parked());
          return { state: "parked" };
        }
        if (end === "closed" && fault && !stopReason && !deps.signal.aborted) {
          await closeSession();
          continue;
        }
        if (end === "closed" || (stopReason && stopReason.kind !== "command")) return await interrupted(stopReason?.kind ?? "the Session closed");
        if (end === "stop" && stopReason?.kind === "command") {
          await session!.interrupt().catch(() => {});
          await harness.waitForIdle(context).catch(() => {});
          return await writeEnd(harness, root, gate, { state: "stopped", summary: "stopped by a person" }, [stopReason.commandId]);
        }
        const outcome = await turn;
        await harness.waitForIdle(context);
        const cutOff = restartLimited(await entriesOf(gate.journal, root.id, context));
        if (cutOff) return await writeEnd(harness, root, gate, { state: "failed", summary: `a tool call faulted on every restart: ${cutOff}` }, []);
        return await writeEnd(harness, root, gate, outcome.status === "completed" ? { state: "ended" } : { state: "failed", summary: `the run gave no answer (${outcome.status})` }, []);
      }
    } catch (error) {
      if (gate?.sealed || deps.signal.aborted) return await interrupted("its claim's signal aborted");
      // A failure with no end written yet. While the journal still takes a commit, the run's end is written with why (the
      // run patch in that commit), so the journal and the live view read it failed too. A parked run brought back is never
      // failed by its resume: thrown, it stays parked and is tried again after a backoff, as is any failure whose end could
      // not be written (pi's Harness could not open): the runner stores that one failed with why. Returning "failed" with
      // no end would leave it running, released and claimed again at once.
      if (claim.from !== "parked" && harness && root && gate && !gate.sealed) {
        const ended = await writeEnd(harness, root, gate, { state: "failed", summary: (error as Error)?.message ?? String(error) }, []).catch(() => undefined);
        if (ended) return ended;
      }
      throw error;
    } finally {
      deps.signal.removeEventListener("abort", signalAbort);
      held?.detach();
      deps.live?.(() => undefined);
      await closeSession();
    }
  }

  /** The gate before a call's intent: the kernel's beforeIntent point, then allow, deny, or ask (answered, or park). */
  function preIntentGate(spec: AdapterRunSpec, hooks: KernelHooks) {
    return async (call: PreIntentCall, _hookContext: Context): Promise<PreIntentAnswer> => {
      const kernelCall: ToolCall = { callId: call.callId, tool: call.tool as never, args: call.args };
      await hooks.beforeIntent(kernelCall);
      const decision = spec.gate?.(kernelCall) ?? "allow";
      if (decision === "deny") return { deny: `Permission denied: ${call.tool} is set to deny.` };
      if (decision === "allow") return "allow";
      const answer = await answerOf(call);
      if (answer === "park") return { park: true };
      return answer.approved ? "allow" : { deny: `Permission denied: a person denied ${call.tool}.` };
    };
  }

  /** An ask's answer: one in the journal stands; else the approve or deny the runner hands over on a resume; else ask and
   *  park (the ask entry with the run parked, in one commit). */
  async function answerOf(call: PreIntentCall): Promise<AnswerData | "park"> {
    const conversation = await harness!.root(context);
    const entries = await entriesOf(gate!.journal, conversation.id, context);
    const known = findData<AnswerData>(entries, KINDS.answer, (data) => data.callId === call.callId);
    if (known) return known;
    if (findData<AskData>(entries, KINDS.ask, (data) => data.callId === call.callId) === undefined) {
      const data: AskData = { callId: call.callId, tool: call.tool };
      const asked = gate!.expect(writesEntry(KINDS.ask, (entry) => entry.callId === call.callId), { run: { state: "parked" } });
      await harness!.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.ask, data: data as unknown as JsonValue }), context);
      await asked;
      parked();
      return "park";
    }
    for (;;) {
      const row = inbox.find((command) => (command.kind === "approve" || command.kind === "deny") && approvalOf(command) === call.callId);
      if (row) {
        inbox.splice(inbox.indexOf(row), 1);
        const data: AnswerData = { callId: call.callId, approved: row.kind === "approve" };
        const answered = gate!.expect(writesEntry(KINDS.answer, (entry) => entry.callId === call.callId), { take: [row.id] });
        await harness!.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.answer, data: data as unknown as JsonValue }), context);
        await answered;
        return data;
      }
      if (stopReason) return "park";
      // The row that woke this run named no waiting call and was refused: the call is asked again and the run parks on
      // it, so a refused approval neither answers it nor keeps the run claimed.
      if (refusals > 0) {
        const data: AskData = { callId: call.callId, tool: call.tool };
        const asked = gate!.expect(writesEntry(KINDS.ask, (entry) => entry.callId === call.callId), { run: { state: "parked" } });
        await harness!.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.ask, data: data as unknown as JsonValue }), context);
        await asked;
        parked();
        return "park";
      }
      await new Promise<void>((resolve) => (wakeInbox = resolve));
    }
  }

  /** Whether a call of this run waits for the answer `approval` names: asked, and not answered yet. */
  async function waitsFor(approval: string | undefined): Promise<boolean> {
    if (approval === undefined) return false;
    await Promise.race([ready, (finished ?? new Promise<never>(() => {})).then(() => undefined, () => undefined)]);
    if (!gate || !harness) return false;
    const conversation = await harness.root(context);
    const entries = await entriesOf(gate.journal, conversation.id, context);
    const asked = findData<AskData>(entries, KINDS.ask, (data) => data.callId === approval) !== undefined;
    return asked && findData<AnswerData>(entries, KINDS.answer, (data) => data.callId === approval) === undefined;
  }

  async function reportHeld(session: Harness, conversationId: ConversationId): Promise<void> {
    held?.detach();
    held = undefined;
    if (!deps.live) return;
    const report = heldReporter(deps.live);
    const observation = (await session.observeDoc(LiveDoc as never, conversationId, {
      advance: (call: { kind: string; value?: unknown; retired?: boolean }) => {
        try {
          if (call.kind === "value") report(call.retired ? undefined : call.value);
        } catch {
          deps.live?.(() => undefined);
        }
      },
      end: () => undefined,
    } as never, context)) as { value?: unknown; detach(): void } | undefined;
    if (!observation) return;
    held = observation;
    report(observation.value);
  }

  /** An interrupted end (a lost claim, a shutdown, the Session closed): the journal sealed first, so nothing written after
   *  reaches the store, then the adapter's interrupt() (where a CLI adapter stops its process), bounded; the session's
   *  close() follows in run()'s finally. */
  async function interrupted(reason: string): Promise<LoopEnd> {
    gate?.seal(new Interrupted(reason));
    if (session) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([session.interrupt().catch(() => {}), new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_MS)))]);
      clearTimeout(timer);
    }
    return { state: "interrupted" };
  }

  /** The session and its Harness closed behind the journal's seal: nothing they write after reaches the store. */
  async function closeSession(): Promise<void> {
    gate?.seal(new Interrupted("the Session is closing"));
    const closing = Promise.all([session?.close().catch(() => {}), harness?.close(BACKGROUND_CONTEXT).catch(() => {})]);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([closing, new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_MS)))]);
    clearTimeout(timer);
    session = undefined;
  }

  async function writeEnd(on: Harness, conversation: Conversation, theGate: Gate, data: EndData, take: readonly number[]): Promise<LoopEnd> {
    const ended = theGate.expect(writesEntry(KINDS.end), { run: { state: data.state, ...(data.summary ? { summary: data.summary } : {}) }, ...(take.length ? { take } : {}) });
    try {
      await on.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.end, data: data as unknown as JsonValue }), context);
    } catch (error) {
      // The end was not written: its expectation fails when the journal is sealed, and nothing waits on it.
      ended.catch(() => undefined);
      throw error;
    }
    await ended;
    return data.state === "failed" ? { state: "failed", error: { code: "run-failed", message: data.summary ?? "the run failed" } } : { state: data.state };
  }

  return {
    start(claim) {
      finished = run(claim);
      return finished;
    },
    async command(command) {
      if (command.kind === "steer") return steer(command);
      if (command.kind === "approve" || command.kind === "deny") {
        // An answer names its approval: the asked call's id. One that names no call waiting for its answer (an old
        // approval, another run's) is refused, never applied to the call that waits now.
        const approval = approvalOf(command);
        if (!(await waitsFor(approval))) {
          refusals += 1;
          wakeInbox();
          return { refused: `no call of this run waits for approval ${JSON.stringify(approval ?? "")}` };
        }
        inbox.push(command);
        wakeInbox();
        return { taken: true };
      }
      return { refused: `an adapter loop takes no ${command.kind} command` };
    },
    async stop(reason) {
      stopReason ??= reason;
      if (reason.kind !== "command") gate?.seal(new Interrupted(reason.kind));
      stopped();
      wakeInbox();
      await finished?.catch(() => undefined);
    },
  };
}

export { Parked };
