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
import { type AdapterSession, type AgentAdapter, type BeforeRequest, type HostTool, modelPortFor, type Refusal, runBooking, type SessionSpec } from "@parcha/agentrun-kernel";
import type { KernelHooks, ToolCall } from "./conformance/subject.js";
import { type AnswerData, type ApprovalPrice, type AskData, type BudgetData, type CallEndData, type CallStartData, type CallStatus, type EndData, KINDS, type MessageData, type RaiseData, withdrawnAnswers } from "./journal-kinds.js";
import { originOf } from "@parcha/pi-durable-agent/timeline";
import { type AlsoRow, type Claim, type Command, type CommandOutcome, deniedText, endedBy, type EndOfRunAnswer, type Loop, type LoopDeps, type LoopEnd, type LoopFactory, noteOf, type StopReason } from "./loop-contract.js";
import { answerText, REFLECT_NOTE_ONLY, reflectRequestId, underLearning, WRITES } from "./end-of-run.js";
import { approvalOf, CLOSE_MS, CUT_STEP_MS, STOP_SETTLE_MS, commandRequest, cutLast, DEFAULT_RESTART_LIMIT, entriesOf, findData, Gate, heldReporter, Interrupted, KernelFault, Parked, quiet, restartLimited, writesEntry, writesSubmission } from "./loop.js";
import type { PiRun, PiSessionIO, PreIntentAnswer, PreIntentCall } from "./adapters/pi.js";
import { HAND_BACK, handBackOf } from "./hand-back.js";
import { journalSessions } from "./sessions.js";
import { sideEffect } from "./side-effects.js";

/** What a raise meets, as the kernel cap's checkRaise reads it (run-adapters/src/kernel/cap/park.ts): the run's cap, the
 *  pause it waits at (none while it works) and its last raise, with the pause that one answered. */
export type RaiseState = { capUsd: number | undefined; final?: boolean; pause?: string | undefined; lastRaise?: { to: number; pause?: string | undefined } };
/** The kernel cap's answer to a raise: raised (and whether it resumes a paused run), a retry of the last, or refused. */
export type RaiseCheck =
  | { raised: true; resumes: boolean; pause?: string; refused?: undefined; retry?: undefined }
  | { retry: true; resumed: boolean; raised?: undefined; refused?: undefined }
  | { refused: string; raised?: undefined; retry?: undefined };

/** What one claimed run's adapter loop runs. */
export interface AdapterRunSpec {
  readonly adapter: AgentAdapter;
  readonly session: SessionSpec;
  /** The person's first message, sent once, on the run's first claim. */
  readonly input: string;
  /** Who keeps the run's visible record (its calls and messages, as the one reader reads them). Absent: the adapter
   *  (pi's own tasks and entries). "loop": a harness whose records are resume log only (a CLI's session): the loop writes
   *  the person's input, each host-tool call's start (after the gate, before the call) and end, and what the model said
   *  (its text events, at each call and turn boundary), and ends interrupted a call a crash or a fault left open. */
  readonly record?: "loop";
  readonly hooks?: KernelHooks;
  /** The gate's answer for a call, before its intent: run it, refuse it, or ask a person (the run parks). */
  readonly gate?: (call: ToolCall) => "allow" | "ask" | "deny";
  /** What an asked call costs, for its approval card (main's tool gate options.price): dollars, or "not metered";
   *  undefined when it has none (the ask says null). */
  readonly approvalPrice?: (call: ToolCall) => ApprovalPrice | undefined;
  /** The host's check before each paid request (the spend cap). */
  readonly beforeRequest?: BeforeRequest;
  /** The run's cap, when it has one (filled from the run's launch): its figure, and what a refusal does to the run (the
   *  kernel cap's parkOf: parked with a pending budget for a refusal a raise could fix, else failed in its words). */
  readonly cap?: {
    readonly capUsd: number;
    park(refusal: { message: string; forGood: boolean; figures?: Refusal["figures"] }): { outcome: "parked"; pending: BudgetData["pending"]; words: string } | { outcome: "failed"; error: string };
    /** The kernel cap's raise rule (checkRaise), as E2 hands it in: the loop never imports the cap. Absent: a raise is
     *  refused, the run having no cap rule to raise by. */
    checkRaise?(state: RaiseState, raiseUsd: number): RaiseCheck;
    /** The kernel cap's follow-up (followUpOf): the server's words a raised run goes on with. */
    followUpOf?(capUsd: number): { readonly text: string };
  };
  /** How long a person's stop waits for the turn to settle before the run is failed in words (a tool call that ignores
   *  its abort). Default STOP_SETTLE_MS. */
  readonly stopSettleMs?: number;
  /** The run's agent: named to the end-of-run step (LoopDeps.endOfRun), which a spec without it cannot be asked. */
  readonly agentId?: string;
  /** The run's work folder, as its file tools resolve a path: what the end-of-run turn's refusal under work/.learning/
   *  reads an absolute path against. Absent: a relative path, or the box's, still counts. */
  readonly workRoot?: string;
  /** The end's patch beside its state: the run's outcome, cost and metrics, read when the end is written and carried in
   *  its commit. Bounded (CUT_STEP_MS): a reader that stalls gives no patch, and the end is still written. */
  readonly endPatch?: (end: EndData) => Promise<Pick<EndData, "outcome" | "costUsd" | "metrics">>;
  /** Handed the run's own Harness commit once it opens (and after each restart's re-open): what a mark of the run's
   *  commits through, so a commit after the claim is lost is refused by the fence like any other. */
  readonly harnessReady?: (commit: Harness["commit"]) => void;
  /** Lets this spec's resources go once the loop writes nothing more through them: called once, after its Session and
   *  Harness are closed, when its pass ends (a restart's included) and at the run's end. Never throws out: a failure is
   *  logged, and the end stands. */
  readonly release?: () => Promise<void>;
}

/** What the loop lends the spec for one Session: the run's Harness (pi adds its turns to it). */
export type AdapterRun = PiRun;

export interface AdapterLoopOptions {
  /** How many times pi restarts a call's task cut off without progress before it ends it (restart_limit); finite.
   *  Default DEFAULT_RESTART_LIMIT. */
  readonly restartLimit?: number;
  /** The gate's clock (epoch ms): when an ask was asked and answered. Default Date.now. */
  readonly now?: () => number;
}

/** The run's visible record, as the loop keeps it for a harness whose own records are resume log only (record: "loop"):
 *  the KINDS entries the one reader reads, on the run's root conversation, each its own commit through the run's Harness
 *  (so the claim fences it like every journal write). */
interface CliRecord {
  /** The adapter's event: text accumulates; a call's start and the turn's end write what was said so far. */
  onEvent(event: Parameters<PiSessionIO["onEvent"]>[0]): void;
  /** What the model said since the last boundary, written now. */
  flushText(): Promise<void>;
  /** The person's input, written once for the run (a resumed claim that finds it writes it again never). */
  person(text: string): Promise<void>;
  /** A call's start, before it runs (once per call id). */
  start(callId: string, tool: string, input: unknown, replaySafe: boolean): Promise<void>;
  /** A started call's end (once). */
  end(callId: string, status: CallStatus, output?: string): Promise<void>;
  /** The end-of-run turn starts: what the model says from now on is that turn's answer, never a message on the record. */
  answering(): void;
  /** The end-of-run turn ended (`status`, its turn's): its prompt and answer as the submission `requestId` names, the same
   *  record pi's adapter writes (done with its answer entry, or unanswered with why), written once. */
  answered(requestId: string, prompt: string, status: string): Promise<void>;
}

/** The record on `root` of the run's Harness: what the journal holds already read once, and every call a crash or a
 *  fault left with a start and no end ended interrupted (the CLI never runs it again: its own resume says so). */
async function openCliRecord(harness: Harness, journal: Gate["journal"], context: Context): Promise<CliRecord> {
  const root = await harness.root(context);
  const append = async (kind: string, data: CallStartData | CallEndData | MessageData): Promise<void> => {
    await harness.commit((tx) => tx.appendEntry(root.id, { kind, data: data as unknown as JsonValue }), context);
  };
  // Each call started on the record: whether it has its end.
  const started = new Map<string, boolean>();
  let personWritten = false;
  for (const entry of await entriesOf(journal, root.id, context)) {
    const data = (entry.data ?? {}) as { callId?: unknown; role?: unknown };
    if (entry.kind === KINDS.callStart && typeof data.callId === "string") started.set(data.callId, started.get(data.callId) ?? false);
    else if (entry.kind === KINDS.callEnd && typeof data.callId === "string") started.set(data.callId, true);
    else if (entry.kind === KINDS.message && data.role === "person") personWritten = true;
  }
  for (const [callId, ended] of started) {
    if (ended) continue;
    await append(KINDS.callEnd, { callId, status: "interrupted" });
    started.set(callId, true);
  }
  let text = "";
  /** The end-of-run turn's answer while that turn runs (answering), else undefined. */
  let answer: string | undefined;
  // One write at a time, in the order they were asked for, a failed one never stopping the next.
  let chain: Promise<void> = Promise.resolve();
  const inTurn = (work: () => Promise<void>): Promise<void> => (chain = chain.then(work, work));
  /** What was said since the last boundary as a model message; at a turn's end, with the cut its adapter reported. */
  const flushText = (cut?: { stopReason?: "length"; outputTokens?: number }) =>
    inTurn(async () => {
      if (text === "") return;
      const said = text;
      text = "";
      const length = cut?.stopReason === "length" ? { stopReason: "length" as const, ...(cut.outputTokens === undefined ? {} : { outputTokens: cut.outputTokens }) } : {};
      await append(KINDS.message, { role: "model", text: said, ...length });
    });
  return {
    onEvent(event) {
      if (event.type === "text") {
        if (answer === undefined) text += event.delta;
        else answer += event.delta;
      } else if (event.type === "tool_start") void flushText().catch(() => undefined);
      else if (event.type === "turn_end") void flushText(event).catch(() => undefined);
    },
    flushText,
    person: (input) =>
      inTurn(async () => {
        if (personWritten) return;
        await append(KINDS.message, { role: "person", text: input });
        personWritten = true;
      }),
    async start(callId, tool, input, replaySafe) {
      await flushText();
      await inTurn(async () => {
        if (started.has(callId)) return;
        await append(KINDS.callStart, { callId, tool, input, replaySafe });
        started.set(callId, false);
      });
    },
    end: (callId, status, output) =>
      inTurn(async () => {
        if (started.get(callId) !== false) return;
        await append(KINDS.callEnd, { callId, status, ...(output === undefined ? {} : { output }) });
        started.set(callId, true);
      }),
    answering() {
      answer = "";
    },
    answered: (requestId, prompt, status) =>
      inTurn(async () => {
        const said = answer ?? "";
        answer = undefined;
        await harness.commit(async (tx) => {
          if (await tx.submissionByRequest(root.id, requestId)) return;
          const asked = await tx.appendEntry(root.id, { kind: KINDS.endOfRunTurn, data: { role: "person", text: prompt }, model: [{ role: "user", content: prompt }] as never });
          if (status !== "completed") {
            await tx.createSubmission({ type: "input", conversationId: root.id, requestId, status: "unanswered", entry: asked.id, reason: `the end-of-run turn ended ${status}` });
            return;
          }
          const answered = await tx.appendEntry(root.id, { kind: KINDS.endOfRunTurn, data: { role: "model", text: said }, model: [{ role: "assistant", content: [{ type: "text", text: said }] }] as never });
          await tx.createSubmission({ type: "input", conversationId: root.id, requestId, status: "done", entry: asked.id, answer: answered.id });
        }, context);
      }),
  };
}

/** Loops for runs on the adapter contract: `spec(claim, run)` gives each Session what it runs. */
export function createAdapterLoop(spec: (claim: Claim, run: AdapterRun) => AdapterRunSpec | Promise<AdapterRunSpec>, options: AdapterLoopOptions = {}): LoopFactory {
  return (deps) => adapterLoop(spec, options, deps);
}

function adapterLoop(specOf: (claim: Claim, run: AdapterRun) => AdapterRunSpec | Promise<AdapterRunSpec>, options: AdapterLoopOptions, deps: LoopDeps): Loop {
  const restartLimit = options.restartLimit ?? DEFAULT_RESTART_LIMIT;
  const now = options.now ?? Date.now;
  /** The gate's clock as main's card says a time: ISO. */
  const isoNow = () => new Date(now()).toISOString();
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
  /** Approve or deny rows refused because they named no call waiting for its answer. */
  let refusals = 0;
  /** The claim's first delivery is done (LoopDeps.delivered): every row the runner read is with the loop. */
  let delivered = false;
  /** Resolved once the claim's Harness is open and its root known: a command's check reads the journal through it. */
  let opened: () => void = () => {};
  const ready = new Promise<void>((resolve) => (opened = resolve));
  let held: { detach(): void } | undefined;
  /** This claim's spec, once known: a raise is checked by its cap's rule, and the end's patch is read from it. */
  let specNow: AdapterRunSpec | undefined;
  /** The current pass's spec's release, until it is called (closeSession). */
  let releaseNow: (() => Promise<void>) | undefined;
  /** While the end-of-run turn runs: a steer is left for the end, and its writes and edits under work/.learning/ are
   *  refused (REFLECT_NOTE_ONLY). */
  let reflecting = false;
  /** The claim's CLI record (record: "loop"), for the end-of-run turn's answer; undefined for an adapter keeping its own. */
  let cliRecord: CliRecord | undefined;
  /** The session's paid requests admitted and not yet booked (its model port's beforeRequest, then its afterRequest), and
   *  who waits for none: the run's end waits for them, since a booking written after the end (the run's release) is
   *  fenced and lost, and its request read back at its hold. */
  let unbooked = 0;
  let bookedAll: (() => void)[] = [];
  /** The raises this claim has: the state the ones before left (the kernel cap's takeRaises, in arrival order), the rows
   *  to take in the raise entry's commit, whether any resumes a paused run, and the budget it answered. */
  const raising: { state?: RaiseState; takes: number[]; resumes: boolean; capUsd?: number; budget?: BudgetData; resuming: boolean } = { takes: [], resumes: false, resuming: false };

  /** The run's raise state, read from its root: the newest budget entry with no raise entry after it is the pause it
   *  waits at (its pending cap is the cap a raise is checked against); the newest raise entry is its last raise. */
  async function raiseStateOf(): Promise<RaiseState> {
    let budget: { id: string; data: BudgetData } | undefined;
    let last: { data: RaiseData; pause?: string } | undefined;
    for (const entry of await entriesOf(gate!.journal, root!.id, context)) {
      if (entry.kind === KINDS.budget) budget = { id: String(entry.id), data: entry.data as unknown as BudgetData };
      if (entry.kind === KINDS.raise) {
        const data = entry.data as unknown as RaiseData & { pause?: string };
        last = { data, ...(data.pause ? { pause: data.pause } : {}) };
        if (budget && data.pause === budget.id) budget = undefined;
      }
    }
    raising.budget = budget?.data;
    const capUsd = budget ? budget.data.pending.cap_usd : (last?.data.capUsd ?? specNow?.cap?.capUsd);
    return { capUsd, ...(budget ? { pause: budget.id } : {}), ...(last ? { lastRaise: { to: last.data.capUsd, pause: last.pause } } : {}) };
  }

  /** A raise row: checked by the cap's rule against the state the raises before it left. Refused in the rule's words;
   *  else taken by the raise entry's commit, now for a working run, or once the claim's delivery is done for a paused run
   *  it woke (raises taken together resume it once). */
  const raise = async (command: Command): Promise<CommandOutcome> => {
    await ready;
    const check = specNow?.cap?.checkRaise;
    if (!check) return { refused: "This run has no cap to raise: a cap is named when a run starts." };
    raising.state ??= await raiseStateOf();
    const usd = (command.body as { capUsd?: unknown } | null)?.capUsd;
    const answer = check(raising.state, typeof usd === "number" ? usd : Number.NaN);
    if (answer.refused !== undefined) return { refused: answer.refused };
    raising.takes.push(command.id);
    if (answer.raised) {
      raising.resumes ||= answer.resumes;
      raising.capUsd = usd as number;
      raising.state = { ...raising.state, capUsd: usd as number, lastRaise: { to: usd as number, pause: raising.state.pause } };
    }
    if (!raising.resuming) await takeRaises();
    return { taken: true };
  };

  /** Hand-backs one at a time: each decides on the journal the one before it left, so a second answer meets the first. */
  let handing: Promise<unknown> = Promise.resolve();
  /** A person's answer to the agent's browser hand-over (hand-back.ts): the first for an ask is its answer, committed as
   *  the answered hand-over entry at the row's own time, the row taken in that commit. A row after the ask lapsed writes
   *  the expiry (at the expiry's time) and is refused; one for an ask answered already, or never made, is refused. */
  const handBack = (command: Command): Promise<CommandOutcome> => {
    const turn = handing.then(async (): Promise<CommandOutcome> => {
      await Promise.race([ready, (finished ?? new Promise<never>(() => {})).then(() => undefined, () => undefined)]);
      const [theGate, theHarness, theRoot] = [gate, harness, root];
      if (!theGate || !theHarness || !theRoot) return { refused: handBackOf([], command.body, command.createdAt).refused! };
      const { write, refused } = handBackOf(await entriesOf(theGate.journal, theRoot.id, context), command.body, command.createdAt);
      if (write) {
        const answers = refused === undefined;
        // The person's answer takes its row in the commit that writes it; an expiry is the ask's own, and takes none.
        const landed = answers ? theGate.expect(writesEntry(KINDS.handover, (data) => data.id === write.id && data.state === write.state), { take: [command.id] }) : undefined;
        landed?.catch(() => undefined);
        await theHarness.commit((tx) => tx.appendEntry(theRoot.id, { kind: KINDS.handover, data: write as unknown as JsonValue }), context);
        await landed;
      }
      return refused === undefined ? { taken: true } : { refused };
    });
    handing = turn.catch(() => undefined);
    return turn;
  };

  /** The raise entry, taking every raise row this claim has in its one commit (each take keyed to the entry). */
  async function takeRaises(): Promise<void> {
    const takes = raising.takes.splice(0);
    if (takes.length === 0) return;
    const data: RaiseData & { pause?: string } = { capUsd: raising.state?.capUsd ?? raising.capUsd ?? 0, takes, ...(raising.state?.lastRaise?.pause ? { pause: raising.state.lastRaise.pause } : {}) };
    // A raise that resumes the pause answers it: the run's row no longer says the cap's words, in the same commit.
    const landed = gate!.expect(writesEntry(KINDS.raise), { take: takes, ...(raising.resumes ? { run: { summary: null } } : {}) });
    try {
      await harness!.commit((tx) => tx.appendEntry(root!.id, { kind: KINDS.raise, data: data as unknown as JsonValue }), context);
    } catch (error) {
      landed.catch(() => undefined);
      throw error;
    }
    await landed;
  }

  const steer = async (command: Command): Promise<CommandOutcome> => {
    // Handed over before the session is open: placed once it is, its outcome the real one (never taken and then dropped).
    if (!gate || !session) await Promise.race([ready, (finished ?? new Promise<never>(() => {})).then(() => undefined, () => undefined)]);
    // The session never opened, or the run is parking or stopping (its journal sealed, its session closed): left
    // untaken for the next claim, which hands it on again; never refused for good.
    if (!gate || !session || gate.sealed) return { later: "the run is parking: the steer waits for its resume" };
    // The run's job has answered and it is looking back before its end: a person's message is not the end-of-run turn's
    // to answer. Left untaken, so the run's end says it came after the answer.
    if (reflecting) return { later: "the run has answered and is ending: the steer is not placed in its end-of-run turn" };
    if (!session.steer) return { refused: "this harness takes no steer mid-turn" };
    const text = typeof (command.body as { text?: unknown } | null)?.text === "string" ? (command.body as { text: string }).text : "";
    const requestId = commandRequest(command.id);
    // A message that answers nothing (a trigger's, answers: false) waits for the turn's end and runs as a turn of its
    // own, never steering the turn in flight, and never as a waiting call's answer.
    const followUp = (command.body as { answers?: unknown } | null)?.answers === false;
    // Who wrote it, when the person did not (a trigger's message): carried on its input, as the Timeline shows it.
    const origin = originOf((command.body as { origin?: unknown } | null)?.origin);
    const taken = gate.expect(writesSubmission(requestId), { take: [command.id] });
    // A seal while the steer is placed fails it before it is awaited: handled here.
    taken.catch(() => undefined);
    const theGate = gate;
    try {
      await session.steer(text, requestId, followUp ? "followUp" : "steer", origin ? { origin } : undefined);
    } catch (error) {
      // Sealed while it was placed (the run parked meanwhile): left for the resume, as above.
      if (theGate.sealed) return { later: "the run is parking: the steer waits for its resume" };
      return { refused: `the steer was not placed: ${(error as Error).message}` };
    }
    await taken.catch(() => {});
    return { taken: true };
  };

  async function run(claim: Claim): Promise<LoopEnd> {
    context = withAbortSignal(deps.signal, BACKGROUND_CONTEXT);
    // Every row the runner read for this claim is with the loop once delivered resolves (at once without a runner's).
    void (deps.delivered ?? Promise.resolve()).then(() => {
      delivered = true;
      wakeInbox();
    });
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
        specNow = spec;
        releaseNow = spec.release;
        // A mark of the run's commits through its own Harness, under its fence.
        const opened_ = harness;
        spec.harnessReady?.((change, ctx) => opened_.commit(change, ctx));
        const hooks = spec.hooks ?? quiet;
        const sessions = journalSessions(harness, context, { flush: () => deps.flush() });
        const writer = await sessions.open(spec.session.key);
        // The host's check is asked with the run's totals, every session of the run summed (the run's one booking), never
        // this session's alone: a cap is the run's. Its last refusal is kept: a turn it ended ends the run in its words.
        const hostCheck = spec.beforeRequest ? runBooking(sessions, spec.beforeRequest) : undefined;
        let refused: Refusal | undefined;
        const beforeRequest: BeforeRequest | undefined = hostCheck && (async (request) => {
          const answer = await hostCheck(request);
          if (answer && "refuse" in answer) refused = answer;
          return answer;
        });
        // The rule before a side effect for every paid model request, on the path every adapter's requests take: the
        // booking writes the request's record, then awaits request_start before the request leaves, so the flush here
        // makes that record and everything before it durable first (each send, a retry's included).
        const booking = await modelPortFor(writer, {
          key: spec.session.key,
          label: spec.session.label,
          ...(beforeRequest ? { beforeRequest } : {}),
          onEvent: async (event) => {
            if (event.type === "request_start") await deps.flush();
          },
        });
        const gateOf = preIntentGate(spec, hooks);
        // A CLI's run: the loop keeps its visible record (record: "loop"), every call a crash or a fault left open ended.
        const record = spec.record === "loop" ? await openCliRecord(harness, gate.journal, context) : undefined;
        cliRecord = record;
        const tools: HostTool[] = spec.session.tools.map((tool) => ({
          ...tool,
          // The rule before a side effect, on the host-tool path every adapter's calls take: after the call's intent, a
          // flush unless the tool is replay-safe, the call, then the beforeResult point. A throw there is the kernel's own
          // fault: the journal is sealed before the harness's result commit, so the Session fails with the call before
          // its result, and the loop restarts it. A CLI's call reaches here only once the gate allowed it (its tool
          // bridge asks first), so its record's start is written here, before the flush and the call, and its end after.
          call: async (args, toolContext) => {
            if (record) await record.start(toolContext.callId, tool.name, args ?? {}, tool.replay === "safe");
            try {
              const answer = await sideEffect({
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
              });
              if (record) await record.end(toolContext.callId, answer.isError ? "failed" : "done", answer.text);
              return answer;
            } catch (error) {
              // A call its stop or its signal cut off ends interrupted; a fault leaves its end to the next open (the
              // journal is sealed now), which ends it interrupted.
              if (record && !(error instanceof KernelFault) && !gate!.sealed) await record.end(toolContext.callId, "interrupted").catch(() => undefined);
              throw error;
            }
          },
        }));
        // The session's model port, counting what it admitted and has not booked yet (a stop's booking comes once the
        // session's proxy sees its upstream end, which can be after pi went idle).
        const port = booking.models;
        unbooked = 0;
        const counted: typeof port = {
          beforeRequest: async (request) => {
            const ticket = await port.beforeRequest(request);
            unbooked += 1;
            return ticket;
          },
          afterRequest: async (...args) => {
            try {
              await port.afterRequest(...args);
            } finally {
              unbooked = Math.max(0, unbooked - 1);
              if (unbooked === 0) for (const wake of bookedAll.splice(0)) wake();
            }
          },
          ...(port.responded ? { responded: port.responded.bind(port) } : {}),
          ...(port.note ? { note: port.note.bind(port) } : {}),
        };
        const io: PiSessionIO = { writer, models: counted, signal: deps.signal, onEvent: record ? (event) => record.onEvent(event) : () => {}, gate: gateOf };
        session = await spec.adapter.open({ ...spec.session, tools }, io);
        root = await harness.root(context);
        // A run brought back from a park: the raises its claim has are taken together, once its delivery is done.
        if (restarts === 0 && claim.from === "parked") {
          raising.resuming = true;
          raising.state ??= await raiseStateOf();
        }
        opened();
        await reportHeld(harness, root.id);
        if (restarts > restartLimit + 1) {
          return await writeEnd(harness, root, gate, { state: "failed", summary: `the kernel faulted on every restart (${restarts} restarts)` }, [], await cutRows(claim, spec, "faulted"));
        }
        let followedUp = false;
        if (raising.resuming) {
          // Every row that woke it has reached its command() first (deps.delivered), so raises sent together are taken
          // together: one raise entry, and the run resumes once, at the latest cap, with one follow-up in the server's
          // words (the kernel cap's takeRaises and followUpOf). Parked at its cap with no raise that resumes it, it parks
          // again on the same budget; its next refusal (a raise short of the need) parks it anew through the cap's rule.
          await deps.delivered;
          raising.resuming = false;
          const paused = raising.budget;
          const resumes = raising.resumes;
          await takeRaises();
          if (paused) {
            if (!resumes || raising.capUsd === undefined || !spec.cap?.followUpOf) return await parkAtCap(harness, root, gate, paused);
            await session!.send(spec.cap.followUpOf(raising.capUsd).text, { id: `agentrun:raise:${raising.state?.lastRaise?.pause ?? "follow-up"}` });
            followedUp = true;
          }
        }
        if (!followedUp && spec.cap?.followUpOf) {
          // A raise that resumed its pause, whose follow-up this claim did not send: a runner lost after the raise entry's
          // commit, before the follow-up's submission or with its turn still open. Sent under its own id, so pi answers
          // one already placed from its submission and never places it twice; and the turn this claim runs, whose end is
          // the run's, is the follow-up's, never the first input's.
          const state = await raiseStateOf();
          if (state.pause === undefined && state.lastRaise?.pause !== undefined) {
            await session!.send(spec.cap.followUpOf(state.lastRaise.to).text, { id: `agentrun:raise:${state.lastRaise.pause}` });
            followedUp = true;
          }
        }
        // A claim that starts a turn (the input, a recovery, a follow-up) waits for that turn's end: state is the session as
        // open found it, and a CLI adapter reads idle once its turn is sent, so state read after a send says nothing.
        const placed = followedUp || session!.state !== "idle";
        if (followedUp) {
          // The follow-up is the turn this claim runs.
        } else if (session!.state === "new") {
          await record?.person(spec.input);
          await session!.send(spec.input);
        }
        else if (session!.state === "open_turn") await session!.recover();
        const turn = placed ? session!.turnEnd() : Promise.resolve({ status: "completed" as const });
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
          // Bounded, the interrupt included: a tool call that ignores its abort keeps the turn from settling, and the claim
          // is renewed meanwhile. Past the bound the run is failed in words, the stop row taken in that end's commit.
          const settleMs = spec.stopSettleMs ?? STOP_SETTLE_MS;
          const settling = (async () => {
            await session!.interrupt().catch(() => {});
            await harness!.waitForIdle(context).catch(() => {});
            return true as const;
          })();
          let timer: NodeJS.Timeout | undefined;
          const settled = await Promise.race([settling, new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), settleMs)))]);
          clearTimeout(timer);
          // A cancel ends the same way, in its own words (main's "cancelled"); the bound is the same.
          const words = endedBy(stopReason.cancel);
          const cut = await cutRows(claim, spec, "stopped");
          if (!settled) return await writeEnd(harness, root, gate, { state: "failed", summary: `${words}, but the turn did not settle within ${settleMs / 1000} s: a tool call ignored its abort` }, [stopReason.commandId], cut);
          return await writeEnd(harness, root, gate, { state: "stopped", summary: words }, [stopReason.commandId], cut);
        }
        const outcome = await turn;
        // What the model said last, on the record before the run's end.
        await record?.flushText();
        await harness.waitForIdle(context);
        const settledEntries = await entriesOf(gate.journal, root.id, context);
        const cutOff = restartLimited(settledEntries);
        let data: EndData;
        if (cutOff) data = { state: "failed", summary: `a tool call faulted on every restart: ${cutOff}` };
        else if (outcome.status !== "completed" && refused) {
          // A turn the host's check refused: what that does to the run is the cap's rule (parkOf), as on main. A refusal a
          // raise could fix parks the run on a raise; one no raise could fix (or a check with no cap) fails it, in the
          // check's own words, never as a run with no answer.
          const park = spec.cap?.park({ message: refused.refuse, forGood: refused.forGood ?? true, ...(refused.figures ? { figures: refused.figures } : {}) });
          if (park?.outcome === "parked") return await parkAtCap(harness, root, gate, { pending: park.pending, words: park.words });
          data = { state: "failed", summary: park?.outcome === "failed" ? park.error : refused.refuse };
        } else if (outcome.status !== "completed") data = { state: "failed", summary: `the run gave no answer (${outcome.status})` };
        else {
          // An answer cut at the model's output limit is unfinished: the run fails, saying so, never ended (loop.ts cutLast,
          // the direct loop's rule: the words are loop-contract's cutAtLimit).
          const cut = cutLast(settledEntries);
          data = cut ? { state: "failed", summary: cut } : { state: "ended" };
        }
        // The end-of-run step, once, before the end: its rows ride in the end commit. A stop or a lost claim during it
        // writes no end of the job's (a person's stop ends the run stopped; a lost claim leaves it for the next claim).
        const step = await endOfRunStep(claim, spec, data.state === "failed" ? "failed" : "completed");
        if (step.kind === "stopped") return await writeEnd(harness, root, gate, { state: "stopped", summary: endedBy(stopReason?.kind === "command" ? stopReason.cancel : undefined) }, [step.commandId], await cutRows(claim, spec, "stopped-looking"));
        if (step.kind === "interrupted") return await interrupted(stopReason?.kind ?? "its claim's signal aborted");
        return await writeEnd(harness, root, gate, data, [], step.also);
      }
    } catch (error) {
      if (gate?.sealed || deps.signal.aborted) return await interrupted("its claim's signal aborted");
      // A failure with no end written yet. While the journal still takes a commit, the run's end is written with why (the
      // run patch in that commit), so the journal and the live view read it failed too. A parked run brought back is never
      // failed by its resume: thrown, it stays parked and is tried again after a backoff, as is any failure whose end could
      // not be written (pi's Harness could not open): the runner stores that one failed with why. Returning "failed" with
      // no end would leave it running, released and claimed again at once.
      if (claim.from !== "parked" && harness && root && gate && !gate.sealed) {
        const ended = await writeEnd(harness, root, gate, { state: "failed", summary: (error as Error)?.message ?? String(error) }, [], specNow ? await cutRows(claim, specNow, "faulted") : []).catch(() => undefined);
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
      // The end-of-run turn's notes are kept only from its answer: a write there is refused before its intent.
      if (reflecting && WRITES.has(call.tool) && underLearning(spec.workRoot, call.args)) return { deny: REFLECT_NOTE_ONLY };
      await hooks.beforeIntent(kernelCall);
      const decision = spec.gate?.(kernelCall) ?? "allow";
      if (decision === "deny") return { deny: `Permission denied: ${call.tool} is set to deny.` };
      if (decision === "allow") return "allow";
      const answer = await answerOf(call, spec.approvalPrice?.(kernelCall) ?? null);
      if (answer === "park") return { park: true };
      return answer.approved ? "allow" : { deny: deniedText(call.tool, answer.note) };
    };
  }

  /** An ask's answer: one in the journal stands; else the approve or deny the runner hands over on a resume; else ask and
   *  park (the ask entry with the run parked, in one commit). The ask is main's approval card: the call's input, when it
   *  was asked and its `price`; asked again on a resume, it is the same request. */
  async function answerOf(call: PreIntentCall, price: ApprovalPrice | null): Promise<AnswerData | "park"> {
    const conversation = await harness!.root(context);
    const entries = await entriesOf(gate!.journal, conversation.id, context);
    const known = findData<AnswerData>(entries, KINDS.answer, (data) => data.callId === call.callId);
    if (known) return known;
    const first = findData<AskData>(entries, KINDS.ask, (data) => data.callId === call.callId);
    const ask: AskData = first ?? { callId: call.callId, tool: call.tool, args: call.args ?? null, requestedAt: isoNow(), price };
    // Commits the root's entry of `kind`, staging `staged` with it. False when the journal is sealed first (another call
    // of the round parked the run): nothing landed, and the expectation's failure is no one's to wait on.
    const entryLands = async (kind: string, data: AskData | AnswerData, staged: Parameters<Gate["expect"]>[1]): Promise<boolean> => {
      const landed = gate!.expect(writesEntry(kind, (entry) => entry.callId === data.callId), staged);
      // A seal while the commit is in flight fails it before it is awaited: handled here, read by the await below.
      landed.catch(() => undefined);
      try {
        await harness!.commit((tx) => tx.appendEntry(conversation.id, { kind, data: data as unknown as JsonValue }), context);
        await landed;
        return true;
      } catch (error) {
        if (gate!.sealed) return false;
        throw error;
      }
    };
    if (first === undefined) {
      // Asked and parked; or held as the parked call is, when another call of the round parked the run first.
      if (await entryLands(KINDS.ask, ask, { run: { state: "parked" } })) parked();
      return "park";
    }
    for (;;) {
      const row = inbox.find((command) => (command.kind === "approve" || command.kind === "deny") && approvalOf(command) === call.callId);
      if (row) {
        inbox.splice(inbox.indexOf(row), 1);
        const approved = row.kind === "approve";
        const data: AnswerData = { callId: call.callId, approved, decision: approved ? "allow" : "deny", answeredAt: isoNow(), ...noteOf(row) };
        if (!(await entryLands(KINDS.answer, data, { take: [row.id] }))) return "park";
        return data;
      }
      if (stopReason) return "park";
      // No answer for this call came with the claim's first delivery (a steer woke the run, or the row that woke it named
      // no waiting call and was refused): the call is asked again and the run parks on it, so it never waits here
      // holding the claim while it reads running.
      if (delivered || refusals > 0) {
        if (await entryLands(KINDS.ask, ask, { run: { state: "parked" } })) parked();
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
    // The pass's resources go once nothing more is written through them (AdapterRunSpec.release), once each.
    const release = releaseNow;
    releaseNow = undefined;
    await release?.().catch((error: unknown) => console.warn(`[runner] its run's release failed: ${(error as Error)?.message ?? String(error)}`));
  }

  /** The end-of-run step (LoopDeps.endOfRun), asked once: the rows to stage with the end; `stopped` when a person's stop
   *  came during it; `interrupted` when the claim was lost or the runner is closing (no end is written, and the next claim
   *  asks it again). A step that throws on its own writes the end without rows: the run's end never waits on it. */
  async function endOfRunStep(claim: Claim, spec: AdapterRunSpec, outcome: "completed" | "failed"): Promise<{ kind: "rows"; also: readonly AlsoRow[] } | { kind: "stopped"; commandId: number } | { kind: "interrupted" }> {
    const cut = (): { kind: "stopped"; commandId: number } | { kind: "interrupted" } | undefined => {
      if (stopReason?.kind === "command") return { kind: "stopped", commandId: stopReason.commandId };
      if (stopReason || deps.signal.aborted) return { kind: "interrupted" };
      return undefined;
    };
    if (!deps.endOfRun) return { kind: "rows", also: [] };
    if (!spec.agentId) throw new Error("the run's spec names no agent, so its end-of-run step cannot be asked");
    try {
      const rows = await deps.endOfRun({ runId: claim.runId, agentId: spec.agentId, claim, outcome, signal: deps.signal, ask: (prompt, opts) => askEndOfRun(claim, prompt, opts.deadlineMs, opts.again === true) });
      return cut() ?? { kind: "rows", also: rows?.also ?? [] };
    } catch (error) {
      return cut() ?? (console.warn(`[runner] ${claim.runId}: its end-of-run step failed: ${(error as Error).message}`), { kind: "rows", also: [] });
    }
  }

  /** What a run cut before it could look back keeps beside its end (LoopDeps.endOfRun with `cut`, never asking): a
   *  person's stop, before or during the end-of-run turn, or a fault. Bounded (CUT_STEP_MS): a step that reads a stalled
   *  store, or throws, keeps nothing, and the end is never held up by it. */
  async function cutRows(claim: Claim, spec: AdapterRunSpec, cut: "stopped" | "stopped-looking" | "faulted"): Promise<readonly AlsoRow[]> {
    if (!deps.endOfRun || !spec.agentId) return [];
    const refuse = () => Promise.reject(new Error("a cut run's end-of-run step asks nothing"));
    let timer: NodeJS.Timeout | undefined;
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

  /** The end-of-run turn: one more turn through the run's session, its request id one per run (a repeat is answered from
   *  its submission, so a later claim never asks the model again), its writes under work/.learning/ refused while it runs.
   *  `again`: its re-ask, a request of its own (one per run too). Aborted at `deadlineMs`. A stop or a lost claim cuts it:
   *  it throws, and the step sees why. */
  async function askEndOfRun(claim: Claim, prompt: string, deadlineMs: number, again = false): Promise<EndOfRunAnswer> {
    if (!session || !harness || !gate || !root) throw new Error("the run's session is not open");
    const on = harness;
    const conversation = root;
    const theSession = session;
    const requestId = reflectRequestId(claim.runId, again);
    const theRecord = cliRecord;
    reflecting = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      // A CLI's record answers a turn it already wrote from its submission, as pi does: its CLI is never asked twice.
      const known = theRecord ? await on.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context) : undefined;
      // How this claim's turn ended; a turn answered before reads as its submission says.
      let turnStatus = "completed";
      if (!known) {
        theRecord?.answering();
        await theSession.send(prompt, { id: requestId });
        const turn = theSession.turnEnd();
        const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), deadlineMs)));
        const end = await Promise.race([turn, timeout, stopping.then(() => "stop" as const), on.closed.then(() => "closed" as const)]);
        if (end === "stop" || end === "closed") throw new Interrupted(stopReason?.kind ?? "the Session closed");
        if (end === "timeout") {
          await theSession.interrupt().catch(() => {});
          await on.waitForIdle(context).catch(() => {});
          await theRecord?.answered(requestId, prompt, "timed out");
          return { timedOut: true };
        }
        // The CLI's turn, as the submission pi's adapter writes: what the step reads next, one reader for both.
        turnStatus = end.status;
        await theRecord?.answered(requestId, prompt, end.status);
      }
      const record = await on.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context);
      if (turnStatus !== "completed" || record?.status !== "done") return { failed: { code: "unanswered", message: "the end-of-run turn gave no answer" } };
      const answer = (await entriesOf(gate.journal, conversation.id, context)).find((entry) => entry.id === record.answer);
      return { ended: true, answer: answerText(answer) };
    } finally {
      clearTimeout(timer);
      reflecting = false;
    }
  }

  /** The end's patch from the run's spec (AdapterRunSpec.endPatch), bounded like the cut step: late or failing, none. */
  async function endPatchOf(data: EndData): Promise<Pick<EndData, "outcome" | "costUsd" | "metrics">> {
    if (!specNow?.endPatch) return {};
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), CUT_STEP_MS)));
    try {
      const patch = await Promise.race([specNow.endPatch(data), late]);
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

  /** The run parked at its cap: its pending budget as an agentrun.budget entry, in one commit with the run parked in the
   *  cap's words (as the ask park's entry and state), and the loop ends parked: a raise row wakes it. */
  async function parkAtCap(on: Harness, conversation: Conversation, theGate: Gate, data: BudgetData): Promise<LoopEnd> {
    const parkedAt = theGate.expect(writesEntry(KINDS.budget), { run: { state: "parked", summary: data.words } });
    try {
      await on.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.budget, data: data as unknown as JsonValue }), context);
    } catch (error) {
      parkedAt.catch(() => undefined);
      throw error;
    }
    await parkedAt;
    theGate.seal(new Parked());
    return { state: "parked" };
  }

  /** Waits, at most CLOSE_MS, until every paid request the session admitted is booked: a person's stop is booked at what
   *  streamed once the session's proxy sees its upstream end. Past the bound the end is written anyway, and a request left
   *  unbooked reads at its hold and bound, the worst it can have cost. */
  async function bookingsSettled(): Promise<void> {
    if (unbooked === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([new Promise<void>((resolve) => bookedAll.push(resolve)), new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_MS)))]);
    clearTimeout(timer);
  }

  /** The end commit: an `agentrun.end` entry carrying the run row's final patch (the spec's end patch in it), the rows
   *  staged with it (the end-of-run step's), and the rows it takes. */
  async function writeEnd(on: Harness, conversation: Conversation, theGate: Gate, base: EndData, take: readonly number[], also: readonly AlsoRow[] = []): Promise<LoopEnd> {
    // The end is the run's release: nothing of this claim lands after it, so its requests' bookings come first.
    await bookingsSettled();
    const patch = await endPatchOf(base);
    const data: EndData = { ...base, ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}), ...(patch.costUsd !== undefined ? { costUsd: patch.costUsd } : {}), ...(patch.metrics !== undefined ? { metrics: patch.metrics } : {}) };
    const run = {
      state: data.state,
      ...(data.summary ? { summary: data.summary } : {}),
      ...(data.outcome !== undefined ? { outcome: data.outcome } : {}),
      ...(data.costUsd !== undefined ? { costUsd: data.costUsd } : {}),
      ...(data.metrics !== undefined ? { metrics: data.metrics } : {}),
    };
    // A person's stop or cancel withdraws every call still waiting for its answer, in the end's own commit: the approval
    // card reads answered (withdrawn), never waiting for good on a final run.
    const byPerson = data.state === "stopped" || stopReason?.kind === "command";
    const withdrawn = byPerson ? withdrawnAnswers(await entriesOf(theGate.journal, conversation.id, context), isoNow()) : [];
    const ended = theGate.expect(writesEntry(KINDS.end), { run, ...(also.length ? { also } : {}), ...(take.length ? { take } : {}) });
    // A seal while the end is committed fails it before it is awaited: handled here, read by the await below.
    ended.catch(() => undefined);
    try {
      await on.commit(async (tx) => {
        for (const answer of withdrawn) await tx.appendEntry(conversation.id, { kind: KINDS.answer, data: answer as unknown as JsonValue });
        return tx.appendEntry(conversation.id, { kind: KINDS.end, data: data as unknown as JsonValue });
      }, context);
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
      if (command.kind === "raise") return raise(command);
      if (command.kind === HAND_BACK) return handBack(command);
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
