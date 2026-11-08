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
  Harness,
  hook,
  type StorageWrite,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { KernelHooks, ToolCall } from "./conformance/subject.js";
import { type AnswerData, type AskData, type EndData, KINDS } from "./journal-kinds.js";
import type { Claim, Command, CommandOutcome, Journal, Loop, LoopDeps, LoopEnd, LoopFactory, StopReason } from "./loop-contract.js";
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
}

/** The first input's request id: pi answers a repeat of it from its submission, so a resumed run never asks twice. */
const INPUT_REQUEST = "agentrun:input";
const commandRequest = (id: number) => `agentrun:command:${id}`;
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

/**
 * The run's journal with the loop's staging matched to commits. stage() replaces what was staged, so the loop never
 * calls it directly: `expect(match, staged)` stages `staged` on the first commit whose batches `match`, merged with any
 * other match of that commit, and resolves once that commit stored a batch. seal() refuses every later commit.
 */
class Gate {
  readonly journal: Journal;
  #sealed: Error | undefined;
  #pending: { match: (batches: readonly (readonly StorageWrite[])[]) => boolean; staged: Staged; landed: () => void; failed: (error: unknown) => void }[] = [];

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
    const hits = this.#pending.filter((pending) => pending.match(batches));
    if (hits.length > 0) target.stage(merge(hits.map((hit) => hit.staged)));
    let result: CommitResult;
    try {
      result = await target.commit(batches, receive as never, context);
    } catch (error) {
      for (const hit of hits) this.#drop(hit).failed(error);
      throw error;
    }
    if (result.stored > 0) for (const hit of hits) this.#drop(hit).landed();
    return result;
  }

  #drop<T>(pending: T): T {
    this.#pending = this.#pending.filter((each) => each !== (pending as never));
    return pending;
  }

  /** Stages `staged` on the first commit whose batches `match`; resolves when that commit stored a batch. */
  expect(match: (batches: readonly (readonly StorageWrite[])[]) => boolean, staged: Staged): Promise<void> {
    return new Promise((landed, failed) => this.#pending.push({ match, staged, landed, failed }));
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

function merge(all: readonly Staged[]): Staged {
  const run = all.reduce<Staged["run"]>((patch, each) => (each.run ? { ...patch, ...each.run } : patch), undefined);
  const also = all.flatMap((each) => each.also ?? []);
  const take = all.flatMap((each) => each.take ?? []);
  return { ...(run ? { run } : {}), ...(also.length ? { also } : {}), ...(take.length ? { take } : {}) };
}

/** Whether `batches` write an entry of `kind` whose data `test` accepts. */
const writesEntry = (kind: string, test: (data: Record<string, unknown>) => boolean = () => true) => (batches: readonly (readonly StorageWrite[])[]) =>
  batches.some((batch) => batch.some((write) => write.type === "entry" && write.value.kind === kind && test((write.value.data ?? {}) as Record<string, unknown>)));
/** Whether `batches` write the submission with request id `requestId`. */
const writesSubmission = (requestId: string) => (batches: readonly (readonly StorageWrite[])[]) =>
  batches.some((batch) => batch.some((write) => write.type === "submission" && write.value.requestId === requestId));

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
    gate = new Gate(deps.journal(claim));
    const theGate = gate;
    context = withAbortSignal(deps.signal, BACKGROUND_CONTEXT);
    const signalAbort = () => theGate.seal(new Interrupted("its claim's signal aborted"));
    deps.signal.addEventListener("abort", signalAbort, { once: true });
    try {
      const answerOf = async (callId: string): Promise<AnswerData | undefined> => findData<AnswerData>(await entriesOf(theGate.journal, root!.id, context), KINDS.answer, (data) => data.callId === callId);
      const askedOf = async (callId: string): Promise<boolean> => findData<AskData>(await entriesOf(theGate.journal, root!.id, context), KINDS.ask, (data) => data.callId === callId) !== undefined;

      /** The gate's ask: an answer in the journal stands; else wait for one on a resume, or ask and park. */
      const answer = async (call: ToolCall, hookContext: Context): Promise<AnswerData> => {
        await ready;
        const known = await answerOf(call.callId);
        if (known) return known;
        if (!(await askedOf(call.callId))) {
          const data: AskData = { callId: call.callId, tool: call.tool };
          const asked = theGate.expect(writesEntry(KINDS.ask, (entry) => entry.callId === call.callId), { run: { state: "parked" } });
          await harness!.commit((tx) => tx.appendEntry(root!.id, { kind: KINDS.ask, data: data as unknown as JsonValue }), context);
          await asked;
          parked();
          return heldUntilAborted(hookContext);
        }
        // Asked before and resumed: the approve or deny row the runner hands over answers it.
        for (;;) {
          const row = inbox.find((command) => command.kind === "approve" || command.kind === "deny");
          if (row) {
            inbox.splice(inbox.indexOf(row), 1);
            const data: AnswerData = { callId: call.callId, approved: row.kind === "approve" };
            const answered = theGate.expect(writesEntry(KINDS.answer, (entry) => entry.callId === call.callId), { take: [row.id] });
            await harness!.commit((tx) => tx.appendEntry(root!.id, { kind: KINDS.answer, data: data as unknown as JsonValue }), context);
            await answered;
            return data;
          }
          if (stopReason) return heldUntilAborted(hookContext);
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
              beforeResult: (output) => hooks.beforeResult(call, output),
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
        ],
      });
      const registry = createRegistry();
      registry.install(kernel);
      harness = await Harness.open(theGate.journal, { models: spec.models, registry, settings: { restartLimit: Number.POSITIVE_INFINITY }, onReport: () => {} }, context);
      root = await harness.root(context, { agent: { model: spec.model, extensions: [kernel] } as never });
      opened();
      for (const command of early.splice(0)) void steer(command);

      // The first input, once: on a resume pi answers the same request id from its submission.
      const input = await root.submit({ type: "input", content: spec.input, requestId: INPUT_REQUEST }, context);
      const answered = input.wait(context).then(() => "answered" as const);
      const end = await Promise.race([answered, parking.then(() => "parked" as const), stopping.then(() => "stop" as const), harness.closed.then(() => "closed" as const)]);
      if (end === "parked") {
        theGate.seal(new Parked());
        return { state: "parked" };
      }
      if (end === "closed" || (stopReason && stopReason.kind !== "command")) {
        theGate.seal(new Interrupted(stopReason?.kind ?? "the Session closed"));
        return { state: "interrupted" };
      }
      if (end === "stop" && stopReason?.kind === "command") {
        await root.abort(context).catch(() => {});
        await harness.waitForIdle(context).catch(() => {});
        return await writeEnd(harness, root, theGate, { state: "stopped", summary: "stopped by a person" }, [stopReason.commandId]);
      }
      await harness.waitForIdle(context);
      const record = await input.status(context);
      const failed = record.status !== "done";
      return await writeEnd(harness, root, theGate, failed ? { state: "failed", summary: "the run gave no answer" } : { state: "ended" }, []);
    } catch (error) {
      // A sealed journal (a lost claim, a shutdown) or an aborted claim: nothing more is written, the next claim resumes.
      if (theGate.sealed || deps.signal.aborted) {
        theGate.seal(new Interrupted("its claim's signal aborted"));
        return { state: "interrupted" };
      }
      return { state: "failed", error: { code: "pi-loop", message: (error as Error).message } };
    } finally {
      deps.signal.removeEventListener("abort", signalAbort);
      // The Session is closed only behind the seal: its abort commits are refused, so the store keeps what it had (a
      // parked call stays before its intent). A close that hangs on a held call is not waited on past CLOSE_MS.
      theGate.seal(new Interrupted("the loop ended"));
      const closing = harness?.close(BACKGROUND_CONTEXT).catch(() => {});
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([closing, new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_MS)))]);
      clearTimeout(timer);
    }
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
