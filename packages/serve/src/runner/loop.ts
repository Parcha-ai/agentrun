// One claimed run (design: "Runners carry many loops"; kernel page: the loop is the run driver). For pi, the loop opens
// pi-durable's own Harness on the run's journal (store.journal(claim), behind the runner's fence), so pi's tasks, entries
// and submissions ARE the run's journal: the kernel's one reader reads them, and the loop writes nothing beside a call or
// a message that pi already records.
//
// The kernel's rule at a tool call (side-effects.ts) on pi: pi commits the call's intent itself (its tool task's execute
// checkpoint) and its result, so the kernel holds the two points around them. Before the intent is pi's `beforeTool`
// hook: the kernel's beforeIntent point, then the gate (allow, ask, deny). After the call is the tool's own execute(): a
// flush unless the tool is replay-safe, the call, then the beforeResult point.
//
// What the loop itself commits, each in one commit with what it stages there (the run row's patch, the command rows it
// takes), matched to that commit by Gate below:
// - a steer: pi's own submission commit for it takes its row;
// - an ask: an `agentrun.ask` entry with the run parked; the answer: an `agentrun.answer` entry taking its row;
// - the end: an `agentrun.end` entry with the run's final state (ended, stopped with why, failed with why), taking a
//   stop's row.
// A park ends the loop with the asked call before its intent: the journal is sealed (every later commit refused) and the
// Harness closed, so nothing moves the call on; the next claim's recovery reruns it from the start, and the gate finds
// the answer. A lost claim or a shutdown seals the journal and ends the loop interrupted, writing nothing more, so the
// next claim resumes where the journal stands.
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type CommitResult,
  type Conversation,
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryRecord,
  GenerationTask,
  Harness,
  hook,
  LiveDoc,
  type StorageWrite,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { KernelHooks, ToolCall } from "./conformance/subject.js";
import { type AnswerData, type AskData, type EndData, KINDS } from "./journal-kinds.js";
import type { Claim, Command, CommandOutcome, HeldState, Journal, Loop, LoopDeps, LoopEnd, LoopFactory, StopReason } from "./loop-contract.js";
import { sideEffect } from "./side-effects.js";
import type { Staged } from "../store/store.js";

/** A tool the loop gives pi: the kernel's flag for whether it may run again after a crash, and the call itself. */
export interface PiTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
  /** May run again after a crash (it changes nothing outside the run): pi's `replay: "safe"`, and no flush before it. */
  readonly replaySafe: boolean;
  /** The call. `signal` is the turn's: a stop or a lost claim aborts it. Its text is the tool's output to the model. */
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

/** What the gate says about a call before its intent: run it, refuse it, or ask a person (the run parks). */
export type GateDecision = "allow" | "ask" | "deny";

/** What one run's pi loop runs: its models and model, its first input, its tools, the gate and the kernel's hooks. */
export interface PiRunSpec {
  readonly models: Models;
  readonly model: { readonly provider: string; readonly modelId: string };
  /** The person's first message, submitted once, on the run's first claim. */
  readonly input: string;
  readonly tools: readonly PiTool[];
  readonly gate?: (call: ToolCall) => GateDecision;
  readonly hooks?: KernelHooks;
  /** How many times pi restarts a call's task cut off without progress before it ends it (restart_limit). Default
   *  DEFAULT_RESTART_LIMIT, pi's own; always finite. */
  readonly restartLimit?: number;
}

/** pi's own default restart limit (pi-durable 1.5.0 agent settings). */
export const DEFAULT_RESTART_LIMIT = 5;

/** The first input's request id: pi answers a repeat of it from its submission, so a resumed run never asks twice. */
const INPUT_REQUEST = "agentrun:input";
const commandRequest = (id: number) => `agentrun:command:${id}`;
/** The approval an approve or deny row names (commands.ts requires it): the asked call's id. */
const approvalOf = (command: Command): string | undefined => {
  const approval = (command.body as { approval?: unknown } | null)?.approval;
  return typeof approval === "string" ? approval : undefined;
};
const quiet: KernelHooks = { beforeIntent: async () => {}, beforeResult: async () => {} };
/** Held until the hook's own context aborts (pi closing the Session), so a parked call never moves on in this process. */
const heldUntilAborted = (hookContext: Context) =>
  new Promise<never>((_, reject) => {
    const signal = hookContext.abortSignal;
    if (signal?.aborted) return reject(new Parked());
    signal?.addEventListener("abort", () => reject(new Parked()), { once: true });
  });
/** How long a loop waits for pi to close a Session it no longer writes through. */
const CLOSE_MS = 2_000;

/** Loops for pi runs: `spec(claim)` gives each claim's run what it runs. */
export function createPiLoop(spec: (claim: Claim) => PiRunSpec | Promise<PiRunSpec>): LoopFactory {
  return (deps) => piLoop(spec, deps);
}

/** Where a commit's batches hold what an expectation waits for: the batch's index and the matched record's id. */
type Matched = { readonly index: number; readonly id: number };
/** Finds the record an expectation waits for in a commit's batches. */
type Match = (batches: readonly (readonly StorageWrite[])[]) => Matched | undefined;
/** What an expectation stages: the run patch and rows, and the commands it takes (by id; each keyed to the matched record). */
type Expected = { readonly run?: Staged["run"]; readonly also?: Staged["also"]; readonly take?: readonly number[] };

/**
 * The run's journal with the loop's staging matched to commits. stage() replaces what was staged, so the loop never
 * calls it directly: `expect(match, expected)` stages `expected` on the first commit whose batches `match`, merged with
 * any other match of that commit, its takes keyed to the matched record (the store writes a take only with that
 * record's batch, so a command is taken with its effect or not at all), and resolves once that batch is stored. seal()
 * refuses every later commit.
 */
class Gate {
  readonly journal: Journal;
  #sealed: Error | undefined;
  #pending: { match: Match; expected: Expected; landed: () => void; failed: (error: unknown) => void }[] = [];

  constructor(inner: Journal) {
    const gate = this;
    this.journal = new Proxy(inner, {
      get(target, key) {
        if (key === "commit") return (batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: never) => void, context: Context) => gate.#commit(target, batches, receive, context);
        if (key === "stage") return () => {
          throw new Error("the loop stages only through its Gate");
        };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  async #commit(target: Journal, batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: never) => void, context: Context): Promise<CommitResult> {
    if (this.#sealed) throw this.#sealed;
    const hits = this.#pending.flatMap((pending) => {
      const at = pending.match(batches);
      return at ? [{ pending, at }] : [];
    });
    if (hits.length > 0) target.stage(merge(hits.map((hit) => ({ expected: hit.pending.expected, at: hit.at }))));
    let result: CommitResult;
    try {
      result = await target.commit(batches, receive as never, context);
    } catch (error) {
      for (const hit of hits) this.#drop(hit.pending).failed(error);
      throw error;
    }
    // Landed when its own batch was stored; one refused (or after a refused one) waits for a later commit.
    for (const hit of hits) if (result.stored > hit.at.index) this.#drop(hit.pending).landed();
    return result;
  }

  #drop<T>(pending: T): T {
    this.#pending = this.#pending.filter((each) => each !== (pending as never));
    return pending;
  }

  /** Stages `expected` on the first commit whose batches `match`; resolves when the matched batch is stored. */
  expect(match: Match, expected: Expected): Promise<void> {
    return new Promise((landed, failed) => this.#pending.push({ match, expected, landed, failed }));
  }

  /** Every later commit is refused with `error`; a pending expectation fails with it. */
  seal(error: Error): void {
    this.#sealed ??= error;
    for (const pending of this.#pending.splice(0)) pending.failed(error);
  }

  get sealed(): boolean {
    return this.#sealed !== undefined;
  }
}

function merge(all: readonly { expected: Expected; at: Matched }[]): Staged {
  const run = all.reduce<Staged["run"]>((patch, { expected }) => (expected.run ? { ...patch, ...expected.run } : patch), undefined);
  const also = all.flatMap(({ expected }) => expected.also ?? []);
  // The patch and rows land with the record their expectation matched (the first that stages any): never on a storage
  // call where that record's batch was refused.
  const effect = all.find(({ expected }) => expected.run !== undefined || (expected.also ?? []).length > 0)?.at.id;
  // Each take keyed to the record its expectation matched: the store writes it only with that record's batch.
  const take = all.flatMap(({ expected, at }) => (expected.take ?? []).map((command) => ({ command, effect: at.id })));
  return { ...(run ? { run } : {}), ...(also.length ? { also } : {}), ...(effect !== undefined && (run || also.length) ? { effect } : {}), ...(take.length ? { take } : {}) };
}

/** Whether `batches` write an entry of `kind` whose data `test` accepts. */
const writesEntry = (kind: string, test: (data: Record<string, unknown>) => boolean = () => true): Match => (batches) =>
  firstMatch(batches, (write) => write.type === "entry" && write.value.kind === kind && test((write.value.data ?? {}) as Record<string, unknown>));
/** Where `batches` write the submission with request id `requestId`. */
const writesSubmission = (requestId: string): Match => (batches) => firstMatch(batches, (write) => write.type === "submission" && write.value.requestId === requestId);
/** The first write of `batches` that `test` takes: its batch's index and its record's id. */
function firstMatch(batches: readonly (readonly StorageWrite[])[], test: (write: StorageWrite) => boolean): Matched | undefined {
  for (const [index, batch] of batches.entries()) {
    for (const write of batch) {
      if (test(write) && (write.type === "entry" || write.type === "submission")) return { index, id: write.value.id as unknown as number };
    }
  }
  return undefined;
}

class Parked extends Error {
  constructor() {
    super("the run parked on an ask: this loop writes nothing more");
  }
}
class Interrupted extends Error {
  constructor(reason: string) {
    super(`the loop stopped (${reason}): it writes nothing more`);
  }
}
/** The kernel's own fault between a call and its result: the Session restarts, the call before its result. */
class KernelFault extends Error {
  constructor(call: ToolCall, cause: unknown) {
    super(`the kernel faulted on ${call.tool} (${call.callId}) before its result: ${(cause as Error)?.message ?? String(cause)}`, { cause });
  }
}

/** A run's held state from its pi.live document: the tools running now and the answer streaming so far. */
function heldStateOf(value: unknown): HeldState | undefined {
  const live = (value ?? {}) as { tools?: { callId: string; name: string; status: string; arguments?: unknown; output?: string }[]; generation?: { message?: { content?: { type: string; text?: string }[] } } };
  const tools = (live.tools ?? []).filter((slot) => slot.status === "running").map((slot) => ({ callId: slot.callId, name: slot.name, ...(slot.arguments !== undefined ? { args: slot.arguments } : {}), ...(slot.output ? { output: slot.output } : {}) }));
  const text = (live.generation?.message?.content ?? []).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
  if (tools.length === 0 && !text) return undefined;
  return { tools, ...(text ? { partial: { text } } : {}) };
}

/** A tool result pi wrote for a call it cut off at its restart limit, as its message, if any. */
function restartLimited(entries: readonly EntryRecord[]): string | undefined {
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result") continue;
    const diagnostics = (entry.data as { diagnostics?: { code?: string; message?: string }[] } | undefined)?.diagnostics ?? [];
    const cut = diagnostics.find((diagnostic) => diagnostic.code === "restart_limit");
    if (cut) return cut.message ?? "restart_limit";
  }
  return undefined;
}

function piLoop(specOf: (claim: Claim) => PiRunSpec | Promise<PiRunSpec>, deps: LoopDeps): Loop {
  const inbox: Command[] = [];
  let wakeInbox: () => void = () => {};
  let stopReason: StopReason | undefined;
  let stopped: () => void = () => {};
  const stopping = new Promise<void>((resolve) => (stopped = resolve));
  let parked: () => void = () => {};
  const parking = new Promise<void>((resolve) => (parked = resolve));
  let finished: Promise<LoopEnd> | undefined;
  let gate: Gate | undefined;
  let root: Conversation | undefined;
  let harness: Harness | undefined;
  /** Resolved once the Harness is open and its root known: a recovered call's hook may run before open() returns. */
  let opened: () => void = () => {};
  const ready = new Promise<void>((resolve) => (opened = resolve));
  let context: Context = BACKGROUND_CONTEXT;
  /** Steers handed over before the root was open: placed once it is. */
  const early: Command[] = [];
  /** Approve or deny rows refused because they named no call waiting for its answer. */
  let refusals = 0;

  /** Whether a call of this run waits for the answer `approval` names: asked, and not answered yet. */
  const waitsFor = async (approval: string | undefined): Promise<boolean> => {
    if (approval === undefined) return false;
    await Promise.race([ready, (finished ?? new Promise<never>(() => {})).then(() => undefined, () => undefined)]);
    if (!gate || !root) return false;
    const entries = await entriesOf(gate.journal, root.id, context);
    const asked = findData<AskData>(entries, KINDS.ask, (data) => data.callId === approval) !== undefined;
    return asked && findData<AnswerData>(entries, KINDS.answer, (data) => data.callId === approval) === undefined;
  };

  /** Places a steer in the run's turn; its row is taken by pi's own commit of that submission. */
  const steer = async (command: Command): Promise<CommandOutcome> => {
    if (!gate || !root) {
      early.push(command);
      return { taken: true };
    }
    const text = typeof (command.body as { text?: unknown } | null)?.text === "string" ? (command.body as { text: string }).text : "";
    const requestId = commandRequest(command.id);
    const taken = gate.expect(writesSubmission(requestId), { take: [command.id] });
    try {
      await root.submit({ type: "input", content: text, requestId, whenBusy: "steer" }, context);
    } catch (error) {
      taken.catch(() => {});
      return { refused: `the steer was not placed: ${(error as Error).message}` };
    }
    await taken.catch(() => {});
    return { taken: true };
  };

  async function run(claim: Claim): Promise<LoopEnd> {
    const spec = await specOf(claim);
    const hooks = spec.hooks ?? quiet;
    const restartLimit = spec.restartLimit ?? DEFAULT_RESTART_LIMIT;
    context = withAbortSignal(deps.signal, BACKGROUND_CONTEXT);
    const signalAbort = () => gate?.seal(new Interrupted("its claim's signal aborted"));
    deps.signal.addEventListener("abort", signalAbort, { once: true });
    /** A fault of the kernel's own between a call and its result, which restarts the Session (see below). */
    let fault: KernelFault | undefined;
    try {
      const answerOf = async (callId: string): Promise<AnswerData | undefined> => findData<AnswerData>(await entriesOf(gate!.journal, root!.id, context), KINDS.answer, (data) => data.callId === callId);
      const askedOf = async (callId: string): Promise<boolean> => findData<AskData>(await entriesOf(gate!.journal, root!.id, context), KINDS.ask, (data) => data.callId === callId) !== undefined;

      /** The gate's ask: an answer in the journal stands; else wait for one on a resume, or ask and park. */
      const answer = async (call: ToolCall, hookContext: Context): Promise<AnswerData> => {
        await ready;
        const known = await answerOf(call.callId);
        if (known) return known;
        if (!(await askedOf(call.callId))) {
          const data: AskData = { callId: call.callId, tool: call.tool };
          const asked = gate!.expect(writesEntry(KINDS.ask, (entry) => entry.callId === call.callId), { run: { state: "parked" } });
          await harness!.commit((tx) => tx.appendEntry(root!.id, { kind: KINDS.ask, data: data as unknown as JsonValue }), context);
          await asked;
          parked();
          return heldUntilAborted(hookContext);
        }
        // Asked before and resumed: the approve or deny row the runner hands over, naming this call, answers it.
        for (;;) {
          const row = inbox.find((command) => (command.kind === "approve" || command.kind === "deny") && approvalOf(command) === call.callId);
          if (row) {
            inbox.splice(inbox.indexOf(row), 1);
            const data: AnswerData = { callId: call.callId, approved: row.kind === "approve" };
            const answered = gate!.expect(writesEntry(KINDS.answer, (entry) => entry.callId === call.callId), { take: [row.id] });
            await harness!.commit((tx) => tx.appendEntry(root!.id, { kind: KINDS.answer, data: data as unknown as JsonValue }), context);
            await answered;
            return data;
          }
          if (stopReason) return heldUntilAborted(hookContext);
          // The row that woke this run named no waiting call and was refused: the call is asked again and the run parks
          // on it, so a refused approval neither answers it nor keeps the run claimed.
          if (refusals > 0) {
            const data: AskData = { callId: call.callId, tool: call.tool };
            const asked = gate!.expect(writesEntry(KINDS.ask, (entry) => entry.callId === call.callId), { run: { state: "parked" } });
            await harness!.commit((tx) => tx.appendEntry(root!.id, { kind: KINDS.ask, data: data as unknown as JsonValue }), context);
            await asked;
            parked();
            return heldUntilAborted(hookContext);
          }
          await new Promise<void>((resolve) => (wakeInbox = resolve));
        }
      };

      const tools = spec.tools.map((tool) =>
        defineTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as never,
          replay: tool.replaySafe ? "safe" : "unsafe",
          execute: async (args: unknown, api, toolContext: Context) => {
            const call: ToolCall = { callId: api.callId, tool: tool.name as never, args: (args ?? {}) as Record<string, unknown> };
            const signal = toolContext.abortSignal ?? deps.signal;
            const text = await sideEffect({
              replaySafe: tool.replaySafe,
              flush: () => deps.flush(),
              route: () => tool.run(call.args, signal),
              // A throw here is the kernel's own fault between the call and its result, not the tool's error: the
              // journal is sealed before it reaches pi, so pi's result commit is refused and its Session fails with the
              // call still before its result; the loop then restarts the Session (see run below).
              beforeResult: async (output) => {
                try {
                  await hooks.beforeResult(call, output);
                } catch (error) {
                  fault = new KernelFault(call, error);
                  gate!.seal(fault);
                  throw fault;
                }
              },
            });
            return { output: [{ type: "text" as const, text }] };
          },
        }),
      );
      const kernel = defineExtension({
        name: "agentrun-kernel",
        tools,
        hooks: [
          hook(ToolTask, {
            beforeTool: async (toolCall, _api, hookContext: Context) => {
              const call: ToolCall = { callId: toolCall.id, tool: toolCall.name as never, args: (toolCall.arguments ?? {}) as Record<string, unknown> };
              await hooks.beforeIntent(call);
              const decision = spec.gate?.(call) ?? "allow";
              if (decision === "deny") return { block: `Permission denied: ${call.tool} is set to deny.` };
              if (decision === "ask" && !(await answer(call, hookContext)).approved) return { block: `Permission denied: a person denied ${call.tool}.` };
              return undefined;
            },
          }),
          // The rule before a side effect for the model too: a paid request leaves only after a flush made every record
          // before it durable (the attempt's request checkpoint among them), so a machine lost after the send never loses
          // that it was asked and sends it again. Once per attempt, recovery and the generation's retries included, for
          // every provider: within an attempt pi writes nothing durable before the send, and pi-ai's resends of it
          // (the same body, or one rebuilt after a refusal) carry no new record.
          hook(GenerationTask, {
            beforeRequest: async () => {
              await deps.flush();
              return undefined;
            },
          }),
        ],
      });
      const registry = createRegistry();
      registry.install(kernel);

      // One Session per pass. A kernel fault (above) fails the Session with its call still before its result; the loop
      // closes it behind the seal and opens the next on the same claim's journal. pi counts that open as a restart of the
      // call's task: a replay-safe call reruns, any other ends interrupted (never run twice), and a call cut off
      // `restartLimit` times is ended by pi itself (restart_limit) and not run again. That bound is pi's own, finite:
      // never an unbounded restart. A run whose call pi cut off that way ends failed, saying so.
      for (let restarts = 0; ; restarts += 1) {
        fault = undefined;
        gate = new Gate(deps.journal(claim));
        if (deps.signal.aborted) gate.seal(new Interrupted("its claim's signal aborted"));
        harness = await Harness.open(gate.journal, { models: spec.models, registry, settings: { restartLimit }, onReport: () => {} }, context);
        root = await harness.root(context, { agent: { model: spec.model, extensions: [kernel] } as never });
        await reportHeld(harness, root.id);
        opened();
        for (const command of early.splice(0)) void steer(command);
        if (restarts > restartLimit + 1) {
          // pi cut the call off long before this; a fault that keeps coming back from elsewhere is bounded here too.
          return await writeEnd(harness, root, gate, { state: "failed", summary: `the kernel faulted on every restart (${restarts} restarts)` }, []);
        }

        // The first input, once: on a resume pi answers the same request id from its submission.
        const input = await root.submit({ type: "input", content: spec.input, requestId: INPUT_REQUEST }, context);
        const answered = input.wait(context).then(() => "answered" as const);
        const end = await Promise.race([answered, parking.then(() => "parked" as const), stopping.then(() => "stop" as const), harness.closed.then(() => "closed" as const)]);
        if (end === "parked") {
          gate.seal(new Parked());
          return { state: "parked" };
        }
        if (end === "closed" && fault && !stopReason && !deps.signal.aborted) {
          await closeBehindSeal(gate, harness);
          continue;
        }
        if (end === "closed" || (stopReason && stopReason.kind !== "command")) {
          gate.seal(new Interrupted(stopReason?.kind ?? "the Session closed"));
          return { state: "interrupted" };
        }
        if (end === "stop" && stopReason?.kind === "command") {
          await root.abort(context).catch(() => {});
          await harness.waitForIdle(context).catch(() => {});
          return await writeEnd(harness, root, gate, { state: "stopped", summary: "stopped by a person" }, [stopReason.commandId]);
        }
        await harness.waitForIdle(context);
        const record = await input.status(context);
        const cutOff = restartLimited(await entriesOf(gate.journal, root.id, context));
        if (cutOff) return await writeEnd(harness, root, gate, { state: "failed", summary: `a tool call faulted on every restart: ${cutOff}` }, []);
        const failed = record.status !== "done";
        return await writeEnd(harness, root, gate, failed ? { state: "failed", summary: "the run gave no answer" } : { state: "ended" }, []);
      }
    } catch (error) {
      // A sealed journal (a lost claim, a shutdown) or an aborted claim: nothing more is written, the next claim resumes.
      if (gate?.sealed || deps.signal.aborted) {
        gate?.seal(new Interrupted("its claim's signal aborted"));
        return { state: "interrupted" };
      }
      // A failure with no end written (pi's Harness could not open, a read failed): thrown, so the runner stores the run
      // failed with why (a parked run brought back stays parked and is tried again after a backoff). Returning "failed"
      // would leave it running, released and claimed again at once.
      throw error;
    } finally {
      deps.signal.removeEventListener("abort", signalAbort);
      held?.detach();
      deps.live?.(undefined);
      if (gate && harness) await closeBehindSeal(gate, harness);
    }
  }

  /** The Session's pi.live document as pi shows it (held changes included), reported through deps.live as each change is
   *  made: its running tools and its partial answer. pi stores these later, collapsed; the live view needs them now. */
  let held: { detach(): void } | undefined;
  async function reportHeld(session: Harness, conversationId: ConversationId): Promise<void> {
    held?.detach();
    held = undefined;
    if (!deps.live) return;
    const report = (value: unknown) => deps.live?.(heldStateOf(value));
    const observation = await session.observeDoc(LiveDoc as never, conversationId, {
      // Never throws out to pi (a throw would detach it for good): a value it cannot read reports nothing held.
      advance: (call: { kind: string; value?: unknown; retired?: boolean }) => {
        try {
          if (call.kind === "value") report(call.retired ? undefined : call.value);
        } catch {
          deps.live?.(undefined);
        }
      },
      end: () => undefined,
    } as never, context) as { value?: unknown; detach(): void } | undefined;
    if (!observation) return;
    held = observation;
    report(observation.value);
  }

  /** Closes a Session behind its journal's seal: its abort commits are refused, so the store keeps what it had (a parked
   *  call stays before its intent, a faulted one before its result). A close that hangs on a held call is not waited on
   *  past CLOSE_MS. */
  async function closeBehindSeal(sealed: Gate, session: Harness): Promise<void> {
    sealed.seal(new Interrupted("the Session is closing"));
    const closing = session.close(BACKGROUND_CONTEXT).catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([closing, new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_MS)))]);
    clearTimeout(timer);
  }

  /** The end commit: an `agentrun.end` entry carrying the run row's final patch and the rows it takes. */
  async function writeEnd(harness: Harness, conversation: Conversation, theGate: Gate, data: EndData, take: readonly number[]): Promise<LoopEnd> {
    const ended = theGate.expect(writesEntry(KINDS.end), { run: { state: data.state, ...(data.summary ? { summary: data.summary } : {}) }, ...(take.length ? { take } : {}) });
    await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.end, data: data as unknown as JsonValue }), context);
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
      return { refused: `a pi loop takes no ${command.kind} command` };
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

/** The root conversation's entries, oldest first. */
async function entriesOf(journal: Journal, conversationId: ConversationId, context: Context): Promise<EntryRecord[]> {
  const out: EntryRecord[] = [];
  for (let cursor: unknown = undefined; ; ) {
    const page = await journal.scanEntries({ conversationId, order: "ascending" } as never, 500, cursor as never, context);
    out.push(...page.items);
    if (page.next === undefined) return out;
    cursor = page.next;
  }
}

function findData<T>(entries: readonly EntryRecord[], kind: string, test: (data: T) => boolean): T | undefined {
  for (const entry of entries) if (entry.kind === kind && test(entry.data as unknown as T)) return entry.data as unknown as T;
  return undefined;
}
