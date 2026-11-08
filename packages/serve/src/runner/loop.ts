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
import type { AlsoRow, Claim, Command, CommandOutcome, EndOfRunAnswer, HeldState, Journal, Loop, LoopDeps, LoopEnd, LoopFactory, StopReason } from "./loop-contract.js";
import { answerText, REFLECT_NOTE_ONLY, reflectRequestId, underLearning, WRITES } from "./end-of-run.js";
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
  /** The run's agent: named to the end-of-run step (LoopDeps.endOfRun), which a spec without it cannot be asked. */
  readonly agentId?: string;
  /** The run's work folder, as its file tools resolve a path: what the end-of-run turn's refusal under work/.learning/
   *  reads an absolute path against. Absent: a relative path, or the box's, still counts. */
  readonly workRoot?: string;
  /** How long a person's stop waits for the turn to settle before the run is failed in words (a tool call that ignores
   *  its abort). Default STOP_SETTLE_MS. */
  readonly stopSettleMs?: number;
  /** The end's patch beside its state: the run's outcome, cost and metrics, read when the end is written and carried in
   *  its commit. Bounded (CUT_STEP_MS): a reader that stalls gives no patch, and the end is still written. */
  readonly endPatch?: (end: EndData) => Promise<Pick<EndData, "outcome" | "costUsd" | "metrics">>;
  /** Handed the run's own Harness commit once it opens (and after each restart's re-open): what the model proxy's request
   *  marks and the cap's marks commit through, so a commit after the claim is lost is refused by the fence like any other. */
  readonly harnessReady?: (commit: Harness["commit"]) => void;
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
/** How long a person's stop waits for the turn to settle, by default. */
const STOP_SETTLE_MS = 30_000;
/** The most a cut run's end-of-run step may take (a store read) before its end is written without its rows. */
const CUT_STEP_MS = 2_000;

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

/** Where each pi.live value the loop observes goes: `live`, as a reader of the run's held state, computed only when the
 *  ticker reads it (once per tick), so an advance costs the same however long the partial answer has grown. */
export function heldReporter(live: NonNullable<LoopDeps["live"]>): (value: unknown) => void {
  return (value) => live(() => heldStateOf(value));
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
  /** Approve or deny rows refused because they named no call waiting for its answer. */
  let refusals = 0;
  /** The claim's first delivery is done (LoopDeps.delivered): every row the runner read is with the loop. */
  let delivered = false;

  /** Whether a call of this run waits for the answer `approval` names: asked, and not answered yet. */
  const waitsFor = async (approval: string | undefined): Promise<boolean> => {
    if (approval === undefined) return false;
    await Promise.race([ready, (finished ?? new Promise<never>(() => {})).then(() => undefined, () => undefined)]);
    if (!gate || !root) return false;
    const entries = await entriesOf(gate.journal, root.id, context);
    const asked = findData<AskData>(entries, KINDS.ask, (data) => data.callId === approval) !== undefined;
    return asked && findData<AnswerData>(entries, KINDS.answer, (data) => data.callId === approval) === undefined;
  };
  /** While the end-of-run turn runs: its writes and edits under work/.learning/ are refused (REFLECT_NOTE_ONLY). */
  let reflecting = false;
  /** The claimed run's spec, once read: its end patch is read from it when the end is written. */
  let runSpec: PiRunSpec | undefined;

  /** Places a steer in the run's turn; its row is taken by pi's own commit of that submission. */
  const steer = async (command: Command): Promise<CommandOutcome> => {
    // Handed over before the root is open: placed once it is, its outcome the real one (never taken and then dropped).
    if (!gate || !root) await Promise.race([ready, (finished ?? new Promise<never>(() => {})).then(() => undefined, () => undefined)]);
    // The loop never opened, or its journal is sealed (the run parks, or it is stopping): left untaken for the next claim,
    // which hands it on again; never refused for good.
    if (!gate || !root) return { later: "the run's loop did not open: the steer waits for its next claim" };
    if (gate.sealed) return { later: "the run is parking: the steer waits for its resume" };
    // The run's job has answered and it is looking back before its end: a person's message is not the end-of-run turn's
    // to answer. Left untaken, so the run's end says it came after the answer.
    if (reflecting) return { later: "the run has answered and is ending: the steer is not placed in its end-of-run turn" };
    const text = typeof (command.body as { text?: unknown } | null)?.text === "string" ? (command.body as { text: string }).text : "";
    const requestId = commandRequest(command.id);
    // A message that answers nothing (a trigger's, answers: false) waits for the turn's end and runs as a turn of its
    // own (pi's follow-up), never steering the turn in flight, and never as a waiting call's answer.
    const followUp = (command.body as { answers?: unknown } | null)?.answers === false;
    const taken = gate.expect(writesSubmission(requestId), { take: [command.id] });
    // A seal while the steer is placed fails it before it is awaited: handled here.
    taken.catch(() => undefined);
    try {
      await root.submit({ type: "input", content: text, requestId, whenBusy: followUp ? "followUp" : "steer" }, context);
    } catch (error) {
      taken.catch(() => {});
      // Sealed while it was placed (the run parked meanwhile): left for the resume, as above.
      if (gate.sealed) return { later: "the run is parking: the steer waits for its resume" };
      return { refused: `the steer was not placed: ${(error as Error).message}` };
    }
    await taken.catch(() => {});
    return { taken: true };
  };

  async function run(claim: Claim): Promise<LoopEnd> {
    const spec = await specOf(claim);
    runSpec = spec;
    const hooks = spec.hooks ?? quiet;
    const restartLimit = spec.restartLimit ?? DEFAULT_RESTART_LIMIT;
    context = withAbortSignal(deps.signal, BACKGROUND_CONTEXT);
    // Every row the runner read for this claim is with the loop once delivered resolves (at once without a runner's).
    void (deps.delivered ?? Promise.resolve()).then(() => {
      delivered = true;
      wakeInbox();
    });
    const signalAbort = () => gate?.seal(new Interrupted("its claim's signal aborted"));
    deps.signal.addEventListener("abort", signalAbort, { once: true });
    /** A fault of the kernel's own between a call and its result, which restarts the Session (see below). */
    let fault: KernelFault | undefined;
    try {
      const answerOf = async (callId: string): Promise<AnswerData | undefined> => findData<AnswerData>(await entriesOf(gate!.journal, root!.id, context), KINDS.answer, (data) => data.callId === callId);
      const askedOf = async (callId: string): Promise<boolean> => findData<AskData>(await entriesOf(gate!.journal, root!.id, context), KINDS.ask, (data) => data.callId === callId) !== undefined;

      /** Commits the root's entry of `kind`, staging `staged` with it. False when the journal is sealed first (another call
       *  of the round parked the run): nothing landed, and the expectation's failure is no one's to wait on. */
      const entryLands = async (kind: string, data: AskData | AnswerData, staged: Parameters<Gate["expect"]>[1]): Promise<boolean> => {
        const landed = gate!.expect(writesEntry(kind, (entry) => entry.callId === data.callId), staged);
        // A seal while the commit is in flight fails it before it is awaited: handled here, read by the await below.
        landed.catch(() => undefined);
        try {
          await harness!.commit((tx) => tx.appendEntry(root!.id, { kind, data: data as unknown as JsonValue }), context);
          await landed;
          return true;
        } catch (error) {
          if (gate!.sealed) return false;
          throw error;
        }
      };

      /** The gate's ask: an answer in the journal stands; else wait for one on a resume, or ask and park. */
      const answer = async (call: ToolCall, hookContext: Context): Promise<AnswerData> => {
        await ready;
        const known = await answerOf(call.callId);
        if (known) return known;
        if (!(await askedOf(call.callId))) {
          // Asked and parked; or held as the parked call is, when another call of the round parked the run first.
          if (await entryLands(KINDS.ask, { callId: call.callId, tool: call.tool }, { run: { state: "parked" } })) parked();
          return heldUntilAborted(hookContext);
        }
        // Asked before and resumed: the approve or deny row the runner hands over, naming this call, answers it.
        for (;;) {
          const row = inbox.find((command) => (command.kind === "approve" || command.kind === "deny") && approvalOf(command) === call.callId);
          if (row) {
            inbox.splice(inbox.indexOf(row), 1);
            const data: AnswerData = { callId: call.callId, approved: row.kind === "approve" };
            if (!(await entryLands(KINDS.answer, data, { take: [row.id] }))) return heldUntilAborted(hookContext);
            return data;
          }
          if (stopReason) return heldUntilAborted(hookContext);
          // No answer for this call came with the claim's first delivery (a steer woke the run, or the row that woke it
          // named no waiting call and was refused): the call is asked again and the run parks on it, so it never waits
          // here holding the claim while it reads running.
          if (delivered || refusals > 0) {
            if (await entryLands(KINDS.ask, { callId: call.callId, tool: call.tool }, { run: { state: "parked" } })) parked();
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
              // The end-of-run turn's notes are kept only from its answer: a write there is refused before its intent.
              if (reflecting && WRITES.has(call.tool) && underLearning(spec.workRoot, call.args)) return { block: REFLECT_NOTE_ONLY };
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
        // The proxy's and the cap's marks commit through the run's own Harness, under its fence.
        const opened_ = harness;
        spec.harnessReady?.((change, ctx) => opened_.commit(change, ctx));
        root = await harness.root(context, { agent: { model: spec.model, extensions: [kernel] } as never });
        await reportHeld(harness, root.id);
        opened();
        if (restarts > restartLimit + 1) {
          // pi cut the call off long before this; a fault that keeps coming back from elsewhere is bounded here too.
          return await writeEnd(harness, root, gate, { state: "failed", summary: `the kernel faulted on every restart (${restarts} restarts)` }, [], await cutRows(claim, spec, "faulted"));
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
          // Bounded, the abort included: a tool call that ignores its abort keeps the turn from settling, and the claim is
          // renewed meanwhile. Past the bound the run is failed in words, the stop row taken in that end's commit.
          const settleMs = spec.stopSettleMs ?? STOP_SETTLE_MS;
          const settling = (async () => {
            await root!.abort(context).catch(() => {});
            await harness!.waitForIdle(context).catch(() => {});
            return true as const;
          })();
          let timer: NodeJS.Timeout | undefined;
          const settled = await Promise.race([settling, new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), settleMs)))]);
          clearTimeout(timer);
          const cut = await cutRows(claim, spec, "stopped");
          if (!settled) return await writeEnd(harness, root, gate, { state: "failed", summary: `stopped by a person, but the turn did not settle within ${settleMs / 1000} s: a tool call ignored its abort` }, [stopReason.commandId], cut);
          return await writeEnd(harness, root, gate, { state: "stopped", summary: "stopped by a person" }, [stopReason.commandId], cut);
        }
        await harness.waitForIdle(context);
        const record = await input.status(context);
        const cutOff = restartLimited(await entriesOf(gate.journal, root.id, context));
        const failed = record.status !== "done";
        const data: EndData = cutOff ? { state: "failed", summary: `a tool call faulted on every restart: ${cutOff}` } : failed ? { state: "failed", summary: "the run gave no answer" } : { state: "ended" };
        // The end-of-run step, once, before the end: its rows ride in the end commit. A stop or a lost claim during it
        // writes no end of the job's (a person's stop ends the run stopped; a lost claim leaves it for the next claim).
        const step = await endOfRunStep(claim, spec, data.state === "failed" ? "failed" : "completed");
        if (step.kind === "stopped") return await writeEnd(harness, root, gate, { state: "stopped", summary: "stopped by a person" }, [step.commandId], await cutRows(claim, spec, "stopped-looking"));
        if (step.kind === "interrupted") {
          gate.seal(new Interrupted(stopReason?.kind ?? "its claim's signal aborted"));
          return { state: "interrupted" };
        }
        return await writeEnd(harness, root, gate, data, [], step.also);
      }
    } catch (error) {
      // A sealed journal (a lost claim, a shutdown) or an aborted claim: nothing more is written, the next claim resumes.
      if (gate?.sealed || deps.signal.aborted) {
        gate?.seal(new Interrupted("its claim's signal aborted"));
        return { state: "interrupted" };
      }
      // A failure with no end written yet. While the journal still takes a commit, the run's end is written with why (the
      // run patch in that commit), so the journal and the live view read it failed too. A parked run brought back is never
      // failed by its resume: thrown, it stays parked and is tried again after a backoff, as is any failure whose end could
      // not be written (pi's Harness could not open): the runner stores that one failed with why. Returning "failed" with
      // no end would leave it running, released and claimed again at once.
      if (claim.from !== "parked" && harness && root && gate && !gate.sealed) {
        const ended = await writeEnd(harness, root, gate, { state: "failed", summary: (error as Error)?.message ?? String(error) }, [], await cutRows(claim, spec, "faulted")).catch(() => undefined);
        if (ended) return ended;
      }
      throw error;
    } finally {
      deps.signal.removeEventListener("abort", signalAbort);
      held?.detach();
      deps.live?.(() => undefined);
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
    const report = heldReporter(deps.live);
    const observation = await session.observeDoc(LiveDoc as never, conversationId, {
      // Never throws out to pi (a throw would detach it for good): a value it cannot read reports nothing held.
      advance: (call: { kind: string; value?: unknown; retired?: boolean }) => {
        try {
          if (call.kind === "value") report(call.retired ? undefined : call.value);
        } catch {
          deps.live?.(() => undefined);
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

  /** The end-of-run step (LoopDeps.endOfRun), asked once: the rows to stage with the end; `stopped` when a person's stop
   *  came during it; `interrupted` when the claim was lost or the runner is closing (no end is written, and the next claim
   *  asks it again). A step that throws on its own writes the end without rows: the run's end never waits on it. */
  async function endOfRunStep(claim: Claim, spec: PiRunSpec, outcome: "completed" | "failed"): Promise<{ kind: "rows"; also: readonly AlsoRow[] } | { kind: "stopped"; commandId: number } | { kind: "interrupted" }> {
    const cut = (): { kind: "stopped"; commandId: number } | { kind: "interrupted" } | undefined => {
      if (stopReason?.kind === "command") return { kind: "stopped", commandId: stopReason.commandId };
      if (stopReason || deps.signal.aborted) return { kind: "interrupted" };
      return undefined;
    };
    if (!deps.endOfRun) return { kind: "rows", also: [] };
    if (!spec.agentId) throw new Error("the run's spec names no agent, so its end-of-run step cannot be asked");
    try {
      const rows = await deps.endOfRun({ runId: claim.runId, agentId: spec.agentId, claim, outcome, signal: deps.signal, ask: (prompt, opts) => askEndOfRun(claim, prompt, opts.deadlineMs) });
      return cut() ?? { kind: "rows", also: rows?.also ?? [] };
    } catch (error) {
      return cut() ?? (console.warn(`[runner] ${claim.runId}: its end-of-run step failed: ${(error as Error).message}`), { kind: "rows", also: [] });
    }
  }

  /** What a run cut before it could look back keeps beside its end (LoopDeps.endOfRun with `cut`, never asking): a
   *  person's stop, before or during the end-of-run turn, or a fault. A step that throws keeps nothing; the end is never
   *  held up by it. */
  async function cutRows(claim: Claim, spec: PiRunSpec, cut: "stopped" | "stopped-looking" | "faulted"): Promise<readonly AlsoRow[]> {
    if (!deps.endOfRun || !spec.agentId) return [];
    const refuse = () => Promise.reject(new Error("a cut run's end-of-run step asks nothing"));
    let timer: NodeJS.Timeout | undefined;
    // Bounded: a person's stop ends within its own bound (stopSettleMs), so a step that reads a stalled store keeps
    // nothing rather than hold the end.
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), CUT_STEP_MS)));
    try {
      const rows = await Promise.race([deps.endOfRun({ runId: claim.runId, agentId: spec.agentId, claim, outcome: "failed", cut, signal: deps.signal, ask: refuse }), late]);
      if (rows === "late") {
        console.warn(`[runner] ${claim.runId}: its end-of-run step gave no answer within ${CUT_STEP_MS / 1000} s; the end is written without it`);
        return [];
      }
      return rows?.also ?? [];
    } catch (error) {
      console.warn(`[runner] ${claim.runId}: its end-of-run step failed: ${(error as Error).message}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** The end-of-run turn: one more input through the run's root, its request id one per run (a repeat is answered from
   *  its submission, so a later claim never asks the model again), its writes under work/.learning/ refused while it runs.
   *  Aborted at `deadlineMs`. A stop or a lost claim cuts it: it throws, and the step sees why. */
  async function askEndOfRun(claim: Claim, prompt: string, deadlineMs: number): Promise<EndOfRunAnswer> {
    if (!root || !harness || !gate) throw new Error("the run's session is not open");
    const session = harness;
    const conversation = root;
    reflecting = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      const turn = await conversation.submit({ type: "input", content: prompt, requestId: reflectRequestId(claim.runId), whenBusy: "followUp" }, context);
      const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), deadlineMs)));
      const end = await Promise.race([turn.wait(context).then(() => "ended" as const), timeout, stopping.then(() => "stop" as const), session.closed.then(() => "closed" as const)]);
      if (end === "stop" || end === "closed") throw new Interrupted(stopReason?.kind ?? "the Session closed");
      if (end === "timeout") {
        await turn.abort(context).catch(() => {});
        await conversation.abort(context).catch(() => {});
        await session.waitForIdle(context).catch(() => {});
        return { timedOut: true };
      }
      const record = await turn.status(context);
      if (record.status !== "done") return { failed: { code: "unanswered", message: "the end-of-run turn gave no answer" } };
      const answer = (await entriesOf(gate.journal, conversation.id, context)).find((entry) => entry.id === record.answer);
      return { ended: true, answer: answerText(answer) };
    } finally {
      clearTimeout(timer);
      reflecting = false;
    }
  }

  /** The end commit: an `agentrun.end` entry carrying the run row's final patch, the rows staged with it (the end-of-run
   *  step's), and the rows it takes. */
  /** The end's patch from the run's spec (PiRunSpec.endPatch), bounded like the cut step: late or failing, none. */
  async function endPatchOf(data: EndData): Promise<Pick<EndData, "outcome" | "costUsd" | "metrics">> {
    if (!runSpec?.endPatch) return {};
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), CUT_STEP_MS)));
    try {
      const patch = await Promise.race([runSpec.endPatch(data), late]);
      if (patch === "late") {
        console.warn(`[runner] its end's patch gave no answer within ${CUT_STEP_MS / 1000} s; the end is written without it`);
        return {};
      }
      return patch ?? {};
    } catch (error) {
      console.warn(`[runner] its end's patch failed: ${(error as Error).message}`);
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  async function writeEnd(harness: Harness, conversation: Conversation, theGate: Gate, base: EndData, take: readonly number[], also: readonly AlsoRow[] = []): Promise<LoopEnd> {
    const patch = await endPatchOf(base);
    const data: EndData = { ...base, ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}), ...(patch.costUsd !== undefined ? { costUsd: patch.costUsd } : {}), ...(patch.metrics !== undefined ? { metrics: patch.metrics } : {}) };
    const run = {
      state: data.state,
      ...(data.summary ? { summary: data.summary } : {}),
      ...(data.outcome !== undefined ? { outcome: data.outcome } : {}),
      ...(data.costUsd !== undefined ? { costUsd: data.costUsd } : {}),
      ...(data.metrics !== undefined ? { metrics: data.metrics } : {}),
    };
    const ended = theGate.expect(writesEntry(KINDS.end), { run, ...(also.length ? { also } : {}), ...(take.length ? { take } : {}) });
    // A seal while the end is committed fails it before it is awaited: handled here, read by the await below.
    ended.catch(() => undefined);
    try {
      await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.end, data: data as unknown as JsonValue }), context);
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
