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
import { type Conversation, type ConversationId, createRegistry, defineDoc, Harness, LiveDoc, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { type AdapterSession, type AgentAdapter, type BeforeRequest, type HostTool, modelPortFor, type Refusal, RUNNER_RECORDS, type SessionRecord, type SessionSpec, sessionSpendOf } from "@parcha/agentrun-kernel";
import type { KernelHooks, ToolCall } from "./conformance/subject.js";
import { type AnswerData, type ApprovalPrice, ASK_PERSON_WAITING, type AskData, type BudgetData, type CallEndData, type CallStartData, type CallStatus, endedAnswer, type EndData, KINDS, type MessageData, type RaiseData, withdrawnAnswers } from "./journal-kinds.js";
import { endedOnTurnEndingTool, HOST_PHASE, type MessageOrigin, originOf, RUN_RESUMED } from "@parcha/pi-durable-agent/timeline";
import { type AlsoRow, type Claim, ClaimRefused, type Command, type CommandOutcome, deniedText, endedBy, type EndOfRunAnswer, type EndOfRunTurn, type Loop, type LoopDeps, type LoopEnd, type LoopFactory, noteOf, type StopReason } from "./loop-contract.js";
import { deniedText as setToDenyText } from "../refusal-words.js";
import { ADAPTER_API } from "../turn-end.js";
import { answerText, REFLECT_NOTE_ONLY, reflectRequestId, underLearning, WRITES } from "./end-of-run.js";
import { approvalOf, CLOSE_MS, CUT_STEP_MS, STOP_SETTLE_MS, commandRequest, cutLast, DEFAULT_RESTART_LIMIT, entriesOf, findData, Gate, heldReporter, Interrupted, KernelFault, Parked, quiet, restartLimited, writesEntry, writesSubmission } from "./loop.js";
import type { PiRun, PiSessionIO, PreIntentAnswer, PreIntentCall } from "./adapters/pi.js";
import { answerOnce, HAND_BACK, handBackOf } from "./hand-back.js";
import { isComputerCommand, type JournalHold, journalHold, type RunComputerHold } from "./computer-journal.js";
import { COMPUTER_HANDOVER_KIND, COMPUTER_HOLD_KIND } from "../computer-commands.js";
import { journalSessions } from "./sessions.js";
import { DECISION_SESSION, runCap, type RunCap, type RunCapOptions, type RunDecisions, type RunTools, TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import { portModels, type PortModels } from "../port-models.js";

/** The run's cap as its spec gives it: the kernel runCap's options but its sessions, which the loop's are. */
export type RunCapConfig = Omit<RunCapOptions, "sessions">;
import { bookedIn } from "../paid-calls.js";
import { sideEffect } from "./side-effects.js";
import { McpClaimRefused } from "./mcp-claim.js";
import { Fenced } from "../store/index.js";
import { type ClaimMcp, parkedFollowUp } from "./mcp-run.js";

/** A pause or resume row on an agentic run, refused in main's words (runs.ts pause): only a workflow run pauses. */
export const AGENTIC_PAUSE_REFUSED = "Only a workflow run pauses here: an agentic run's turn is stopped with POST /runs/{id}/stop.";

/** What a raise meets, as the kernel cap's checkRaise reads it (run-adapters/src/kernel/cap/park.ts): the run's cap, the
 *  pause it waits at (none while it works) and its last raise, with the pause that one answered. */
export type RaiseState = { capUsd: number | undefined; final?: boolean; pause?: string | undefined; lastRaise?: { to: number; pause?: string | undefined } };
/** The kernel cap's answer to a raise: raised (and whether it resumes a paused run), a retry of the last, or refused. */
export type RaiseCheck =
  | { raised: true; resumes: boolean; pause?: string; refused?: undefined; retry?: undefined }
  | { retry: true; resumed: boolean; raised?: undefined; refused?: undefined }
  | { refused: string; raised?: undefined; retry?: undefined };

/** The gate's answer for a call: run it, ask a person, or refuse it (with the words the model reads, or generic ones). */
export type GateAnswer = "allow" | "ask" | "deny" | { readonly deny: string };
/** The gate before a call's intent; `askedAs`, when it has one, names a call as a person is asked about it (its settings
 *  key, as main's pending approval names it), else the call is asked about by its own name. */
export type SpecGate = ((call: ToolCall) => GateAnswer | Promise<GateAnswer>) & { readonly askedAs?: (tool: string) => string };

/** What one claimed run's adapter loop runs. */
export interface AdapterRunSpec {
  readonly adapter: AgentAdapter;
  readonly session: SessionSpec;
  /** The person's first message, sent once, on the run's first claim. */
  readonly input: string;
  /** Who wrote the first message when the person did not: a trigger's (its launch's inputOrigin, with the launch's own
   *  owner flag). The first input is then written as that origin's, never the person's. */
  readonly inputOrigin?: MessageOrigin;
  /** Who keeps the run's visible record (its calls and messages, as the one reader reads them). Absent: the adapter
   *  (pi's own tasks and entries). "loop": a harness whose records are resume log only (a CLI's session): the loop writes
   *  the person's input, each host-tool call's start (after the gate, before the call) and end, and what the model said
   *  (its text events, at each call and turn boundary), and ends interrupted a call a crash or a fault left open. */
  readonly record?: "loop";
  readonly hooks?: KernelHooks;
  /** The gate's answer for a call, before its intent: run it, refuse it, or ask a person (the run parks). A refusal may
   *  carry the words the model reads (`{ deny }`: where the deny was set, a pin's words); a bare "deny" gets generic ones. */
  readonly gate?: SpecGate;
  /** What an asked call costs, for its approval card (main's tool gate options.price): dollars, or "not metered";
   *  undefined when it has none (the ask says null). */
  readonly approvalPrice?: (call: ToolCall) => ApprovalPrice | undefined;
  /** The run's one cap (the kernel's runCap, built by the loop from the run's own sessions): every paid request of the
   *  run, its model requests, its paid tool calls and its decisions, is admitted and booked through it. An uncapped run
   *  gives capUsd: () => undefined. */
  readonly runCap: RunCapConfig;
  /** The run's cap, when it has one (filled from the run's launch): its figure, and what a refusal does to the run (the
   *  kernel cap's parkOf: parked with a pending budget for a refusal a raise could fix, else failed in its words), at the
   *  cap the run is held to when it parks (`capUsd`: the newest raise's, else the launch's), which its pending budget
   *  names and the next raise is checked against. */
  readonly cap?: {
    readonly capUsd: number;
    park(refusal: { message: string; forGood: boolean; figures?: Refusal["figures"] }, capUsd: number): { outcome: "parked"; pending: BudgetData["pending"]; words: string } | { outcome: "failed"; error: string };
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
  /** The run's end-of-run step, when its spec builds one (over the per-claim resources it holds, its Archil claim among
   *  them): it wins over LoopDeps.endOfRun and is asked where that one is, in the end turn while the claim is held, before
   *  a tool host's beforeRelease and the run's release, its rows in the end's commit. */
  readonly endOfRun?: EndOfRunTurn;
  /** The run's work folder, as its file tools resolve a path: what the end-of-run turn's refusal under work/.learning/
   *  reads an absolute path against. Absent: a relative path, or the box's, still counts. */
  readonly workRoot?: string;
  /** The end's patch beside its state: the run's outcome, cost and metrics, read when the end is written and carried in
   *  its commit. Bounded (CUT_STEP_MS): a reader that stalls gives no patch, and the end is still written. */
  readonly endPatch?: (end: EndData) => Promise<Pick<EndData, "outcome" | "costUsd" | "metrics">>;
  /** Handed the run's own Harness commit once it opens (and after each restart's re-open): what a mark of the run's
   *  commits through, so a commit after the claim is lost is refused by the fence like any other. */
  readonly harnessReady?: (commit: Harness["commit"]) => void;
  /** The run's desktop or phone and the person's hold on it (workspace/computer-hold.ts): the loop commits the hold's
   *  changes to the run's journal, which the server reads (computer-routes.ts), and applies the person's take-over and
   *  hand-back rows to it (runner/computer-journal.ts). */
  readonly computer?: RunComputerHold;
  /** Lets this spec's resources go once the loop writes nothing more through them: called once, after its Session and
   *  Harness are closed, when its pass ends (a restart's included) and at the run's end. Never throws out: a failure is
   *  logged, and the end stands. */
  readonly release?: () => Promise<void>;
  /** What the spec's tool host bindings registered (tools.ts ToolHost's onConversation, beforeResume, beforeRelease),
   *  run where main's per-run process runs them (app.ts): each agent conversation's creating commit, once the claim's
   *  Harness is open and before anything in it resumes, and when the claim lets the run go (its end, a park, a
   *  shutdown) with the Harness still open. hostLifecycle() collects them as a ToolHost registers them. */
  readonly lifecycle?: HostLifecycle;
  /** The claim's remote MCP servers, as the spec builder's mcpForClaim opened them (runner/mcp-run.ts): their tools reach
   *  the session through the loop's gate, a command row makes them fresh again, and the pass's end lets them go. Absent:
   *  the run grants no MCP tool. */
  readonly mcp?: ClaimMcp;
}

/** A tool host's lifecycle, as its bindings registered it: run by the adapter loop (AdapterRunSpec.lifecycle). */
export interface HostLifecycle {
  readonly onConversation: readonly ((tx: Tx, conversationId: number) => void | Promise<void>)[];
  readonly beforeResume: readonly ((harness: Harness) => void | Promise<void>)[];
  readonly beforeRelease: readonly ((harness: Harness) => void | Promise<void>)[];
  /** Asked when the run's turn ends on its question to the person (ask_person), before it parks: a tool host holding
   *  something the person may still use while they answer (the browser's open session, its live view, its page) holds the
   *  person's time for it under the run's cap and answers a PersonWait, and the run waits in its claim (the browser's
   *  hand-over waits the same way). Undefined from every host (nothing open, no room under the cap, or past the wait's
   *  bound): the run parks. `since` (ms): when the wait first started, kept in the journal, so a later claim's wait keeps
   *  the first one's bound. */
  readonly personWait?: readonly ((harness: Harness, callId: string, since: number) => Promise<PersonWait | undefined>)[];
}

/** The request ids of the person's messages placed as turns (loop.ts commandRequest). */
const COMMAND_REQUEST_PREFIX = commandRequest(0).replace(/0$/, "");
/** How a session's turn ended (AdapterSession.turnEnd). */
type TurnEnd = Awaited<ReturnType<AdapterSession["turnEnd"]>>;

/** A tool host's hold while the run waits in its claim on the person's answer (HostLifecycle.personWait): the person's
 *  time it holds goes with drop(), once the answer comes or the run ends or parks; `lapsed` settles, in words, when the
 *  hold can no longer stand (the cap refused more of the person's time, or what it kept is gone), and the run parks. */
export interface PersonWait {
  readonly lapsed: Promise<string>;
  drop(): void;
}

/** A HostLifecycle and the ToolHost members that fill it: what a spec's ToolHost takes, and hands the loop. */
export function hostLifecycle(): HostLifecycle & {
  register: { onConversation(write: HostLifecycle["onConversation"][number]): void; beforeResume(settle: HostLifecycle["beforeResume"][number]): void; beforeRelease(stop: HostLifecycle["beforeRelease"][number]): void; personWait(hold: NonNullable<HostLifecycle["personWait"]>[number]): void };
} {
  const onConversation: HostLifecycle["onConversation"][number][] = [];
  const beforeResume: HostLifecycle["beforeResume"][number][] = [];
  const beforeRelease: HostLifecycle["beforeRelease"][number][] = [];
  const personWait: NonNullable<HostLifecycle["personWait"]>[number][] = [];
  return {
    onConversation, beforeResume, beforeRelease, personWait,
    register: {
      onConversation: (write) => void onConversation.push(write),
      beforeResume: (settle) => void beforeResume.push(settle),
      beforeRelease: (stop) => void beforeRelease.push(stop),
      personWait: (hold) => void personWait.push(hold),
    },
  };
}

/** The conversations a tool host sees (onConversation), as main's harness gives them: the agent's, the root and any
 *  subagent's pi opens (its record names its owner: the task, and the conversation it ran in), never the loop's own
 *  session records (no owner, and not the root). */
export function agentConversation(record: { readonly id: number | ConversationId; readonly owner?: { readonly taskId: unknown } }): boolean {
  return Number(record.id) === Number(ROOT_CONVERSATION_ID) || record.owner !== undefined;
}

/** On the run's root: the spec's onConversation writes for it are owed (a phase made the root while the spec was built,
 *  before the spec's lifecycle was known). Set in the root's creating commit, cleared in the commit that makes them, so a
 *  claim lost in between leaves them to the next claim. */
const RootWritesOwed = defineDoc<{ owed: boolean }>({ kind: "agentrun.root-writes-owed", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ owed: false }), checkpointWhen: () => false });

/** What the loop lends the spec for one Session: the run's Harness (pi adds its turns to it). */
export type AdapterRun = PiRun & {
  /** The run's one cap's handles, made before the spec is (so a tool host binds them at its bind): its decisions, its
   *  paid calls (a charge outside any call, a browser release's, books here too) and its proxied models by label (a
   *  learned workflow's model nodes). Read from the spec's runCap once the spec is known. */
  readonly ledger: RunLedger;
  /** The runner's one redactor (LoopDeps.redact; runner.ts), the same instance: the spec gives it to every place a secret
   *  could reach text (the session's model proxy, the model route's translation, its log lines). Absent where no runner
   *  gave one (a spec built alone). */
  readonly redact?: (text: string) => string;
  /** The claim's signal (LoopDeps.signal): aborted on a lost claim or the runner's shutdown, never on a person's stop. A
   *  spec's per-claim resources let go of what they hold at once on it (the run's Archil mount credential). Absent where
   *  no loop gave one (a spec built alone). */
  readonly signal?: AbortSignal;
  /** The claim's signal, also aborted by any stop of the run (a person's stop or cancel among them): what a spec waits on
   *  while it is built (a CLI harness's first-use install), so a stop ends that wait at once and never the work it waits
   *  for. Absent where no loop gave one. */
  readonly stopped?: AbortSignal;
  /** Stages the run row's `summary` on the next commit of this pass that writes a root entry of `kind` whose data `test`
   *  takes, in that commit (a tool host's wait on the person, its claim held: the server tells run.needs_input by the
   *  summary). Absent where no loop gave one. */
  readonly rowSummaryOn?: (kind: string, test: (data: Record<string, unknown>) => boolean, summary: string | null) => void;
  /** Says a step of the host's own on the run's timeline: one `phase` row (HOST_PHASE) with `summary`, at the time it is
   *  said. Said while the spec is built (before the loop makes the run's root), it is written in the root's creating
   *  commit; said after, at once. Absent where no loop gave one (a spec built alone). */
  readonly phase?: (summary: string) => void;
};

/** What the adapter loop hands a run's tool host: the run's decisions, paid calls and proxied models, on its one cap. */
export interface RunLedger {
  readonly decisions: RunDecisions;
  readonly paid: RunTools;
  /** The session's proxied models for a request the host sends beside the harness's own, under `label` (portModels on
   *  the session's port), read at each request: a spec may take them at its build, before the session opens; a request
   *  made while no port is up (no session, or a harness with none) finds no model. */
  models(label: string): Promise<PortModels>;
  /** A paid call the run's cap refused that pauses the run (an agent's ask for a person's browser time: main's paidCall
   *  pause): its pause is journaled at once, as a refused request's is (pauseAtCap), and the run's next request is refused
   *  in its words, so the run parks there with the cap's figures. A take-over's refusal pauses nothing: it is not called. */
  pause(refusal: Refusal): Promise<void>;
}

export interface AdapterLoopOptions {
  /** How many times pi restarts a call's task cut off without progress before it ends it (restart_limit); finite.
   *  Default DEFAULT_RESTART_LIMIT. */
  readonly restartLimit?: number;
  /** The gate's clock (epoch ms): when an ask was asked and answered, and when a wait in the claim on the person's answer
   *  started. Default Date.now. */
  readonly now?: () => number;
  /** For tests: awaited as a wait in the claim on the person's answer starts, before it takes their messages. */
  readonly beforePersonWait?: () => Promise<void>;
}

/** The most of a harness's own turn error a failed run's summary keeps. */
const TURN_ERROR_MAX = 500;

/** `text` cut to at most `max` UTF-16 units, never inside a character: a high surrogate the cut leaves alone goes too. */
const cutWhole = (text: string, max: number): string => {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/** pi's answer entry: the timeline reads an error answer (stopReason "error") as the run's error row. */
const PI_ASSISTANT = "pi.assistant";

/** A CLI turn's error as pi's own error answer, the one main's harness writes for it (harness-app.ts assistantMessage):
 *  the harness for provider and model, the error's words, $0, so the timeline shows its error row in those words. */
const cliErrorAnswer = (harness: string, error: string, at: number) => ({
  role: "assistant",
  content: [],
  api: ADAPTER_API,
  provider: harness,
  model: harness,
  stopReason: "error",
  errorMessage: error,
  timestamp: at,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

/** The turns a session's records booked (its runner.turn records), in order. */
export function turnsOf(records: readonly SessionRecord[]): number[] {
  return records.filter((record) => record.kind === RUNNER_RECORDS.turn).map((record) => (record.data as { turn?: unknown }).turn).filter((turn): turn is number => typeof turn === "number");
}

/** The turns whose requests were side requests (their runner.request record marked `side`, or under a `host` label):
 *  a client's call on another model, a summary, or the host's own request beside the harness's (a learned workflow's
 *  model node). They are no answer's own. */
function sideTurnsOf(records: readonly SessionRecord[]): Set<number> {
  const side = new Set<number>();
  for (const record of records) {
    if (record.kind !== RUNNER_RECORDS.request) continue;
    const data = record.data as { turn?: unknown; side?: unknown; host?: unknown };
    if (typeof data.turn === "number" && (data.side === true || typeof data.host === "string")) side.add(data.turn);
  }
  return side;
}

/** What the request that just answered cost, from the session's records, and the bookings that answer gives (`turns`):
 *  every runner.turn record no answer was given yet (`given`). A side request's booking (sideTurnsOf) is given and never
 *  read: it is no answer's, and it stays on the run's ledger and cap. The answer reads the session's own requests
 *  booked since the answer before it, their booked figures summed (pi asks one at a time, so that is its own; were a
 *  retry ever booked without an answer of its own, it would be summed in), null when any is unknown; undefined when none
 *  is booked. Each booking is given once, so one unknown figure stays that answer's, never every later answer's. */
export function bookingOfAnswer(records: readonly SessionRecord[], given: ReadonlySet<number>): { turns: number[]; usd: number | null | undefined } {
  const side = sideTurnsOf(records);
  const turns: number[] = [];
  let usd: number | null | undefined;
  for (const record of records) {
    if (record.kind !== RUNNER_RECORDS.turn) continue;
    const turn = record.data as { turn?: unknown; usd?: unknown; bookedUsd?: unknown };
    if (typeof turn.turn !== "number" || given.has(turn.turn)) continue;
    turns.push(turn.turn);
    if (side.has(turn.turn)) continue;
    const figure = turn.bookedUsd !== undefined ? turn.bookedUsd : turn.usd;
    usd = usd !== null && typeof figure === "number" && Number.isFinite(figure) ? (usd ?? 0) + figure : null;
  }
  return { turns, usd };
}

/** A host check's refusal as the cap's rule reads it (AdapterRunSpec.cap.park). */
const refusalOf = (refusal: Refusal) => ({ message: refusal.refuse, forGood: refusal.forGood ?? true, ...(refusal.figures ? { figures: refusal.figures } : {}) });

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
  /** The first input when someone other than the person wrote it (a trigger's): the host's input entry with its origin, as
   *  pi's steer writes one, once for the run like the person's. */
  input(text: string, origin: MessageOrigin): Promise<void>;
  /** A call's start, before it runs (once per call id). */
  start(callId: string, tool: string, input: unknown, replaySafe: boolean): Promise<void>;
  /** The end the record holds for a call, if any: a call issued again under its id is answered from it, never run. */
  endOf(callId: string): { status: CallStatus; output?: string } | undefined;
  /** A started call's end (once). */
  end(callId: string, status: CallStatus, output?: string): Promise<void>;
  /** The end-of-run turn starts: what the model says from now on is that turn's answer, never a message on the record. */
  answering(): void;
  /** The end-of-run turn ended (`status`, its turn's): its prompt and answer as the submission `requestId` names, the same
   *  record pi's adapter writes (done with its answer entry, or unanswered with why), written once. */
  answered(requestId: string, prompt: string, status: string): Promise<void>;
}

/** The record on `root` of the run's Harness: what the journal holds already read once, and every call a crash or a
 *  fault left with a start and no end ended interrupted (the CLI never runs it again: its own resume says so). Each entry
 *  it writes carries when it was written (`at`, ms, from the loop's clock `now`), as pi's own entries carry their
 *  message's timestamp: the Timeline dates its rows by them. */
async function openCliRecord(harness: Harness, journal: Gate["journal"], context: Context, now: () => number): Promise<CliRecord> {
  const root = await harness.root(context);
  const append = async (kind: string, data: CallStartData | CallEndData | MessageData): Promise<void> => {
    await harness.commit((tx) => tx.appendEntry(root.id, { kind, data: { ...data, at: now() } as unknown as JsonValue }), context);
  };
  // Each call started on the record: whether it has its end; and each end, by call id.
  const started = new Map<string, boolean>();
  const ends = new Map<string, { status: CallStatus; output?: string }>();
  let personWritten = false;
  for (const entry of await entriesOf(journal, root.id, context)) {
    const data = (entry.data ?? {}) as { callId?: unknown; role?: unknown; status?: CallStatus; output?: unknown };
    if (entry.kind === KINDS.callEnd && typeof data.callId === "string") ends.set(data.callId, { status: data.status ?? "done", ...(typeof data.output === "string" ? { output: data.output } : {}) });
    if (entry.kind === KINDS.callStart && typeof data.callId === "string") started.set(data.callId, started.get(data.callId) ?? false);
    else if (entry.kind === KINDS.callEnd && typeof data.callId === "string") started.set(data.callId, true);
    else if ((entry.kind === KINDS.message && data.role === "person") || entry.kind === KINDS.input) personWritten = true;
  }
  for (const [callId, ended] of started) {
    if (ended) continue;
    await append(KINDS.callEnd, { callId, status: "interrupted" });
    started.set(callId, true);
    ends.set(callId, { status: "interrupted" });
  }
  let text = "";
  /** The end-of-run turn's answer while that turn runs (answering), else undefined. */
  let answer: string | undefined;
  // One write at a time, in the order they were asked for, a failed one never stopping the next.
  let chain: Promise<void> = Promise.resolve();
  const inTurn = (work: () => Promise<void>): Promise<void> => (chain = chain.then(work, work));
  /** What was said since the last boundary as a model message; at a turn's end, with the cut its adapter reported. */
  const flushText = (cut?: { stopReason?: "length"; outputTokens?: number }) => {
    // Taken at the boundary, not when its write's turn comes: text said after it is the next message's.
    const said = text;
    text = "";
    return inTurn(async () => {
      if (said === "") return;
      const length = cut?.stopReason === "length" ? { stopReason: "length" as const, ...(cut.outputTokens === undefined ? {} : { outputTokens: cut.outputTokens }) } : {};
      await append(KINDS.message, { role: "model", text: said, ...length });
    });
  };
  return {
    onEvent(event) {
      if (event.type === "text") {
        if (answer === undefined) text += event.delta;
        else answer += event.delta;
      } else if (event.type === "tool_start" || event.type === "text_end") void flushText().catch(() => undefined);
      else if (event.type === "turn_end") void flushText(event).catch(() => undefined);
    },
    flushText,
    person: (input) =>
      inTurn(async () => {
        if (personWritten) return;
        await append(KINDS.message, { role: "person", text: input });
        personWritten = true;
      }),
    input: (input, origin) =>
      inTurn(async () => {
        if (personWritten) return;
        await harness.commit((tx) => tx.appendEntry(root.id, { kind: KINDS.input, data: { origin } as unknown as JsonValue, model: [{ role: "user", content: input, timestamp: now() }] } as never), context);
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
    endOf: (callId) => ends.get(callId),
    end: (callId, status, output) =>
      inTurn(async () => {
        if (started.get(callId) !== false) return;
        await append(KINDS.callEnd, { callId, status, ...(output === undefined ? {} : { output }) });
        started.set(callId, true);
        ends.set(callId, { status, ...(output === undefined ? {} : { output }) });
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
          const asked = await tx.appendEntry(root.id, { kind: KINDS.endOfRunTurn, data: { role: "person", text: prompt }, model: [{ role: "user", content: prompt, timestamp: now() }] as never });
          if (status !== "completed") {
            await tx.createSubmission({ type: "input", conversationId: root.id, requestId, status: "unanswered", entry: asked.id, reason: `the end-of-run turn ended ${status}` });
            return;
          }
          const answered = await tx.appendEntry(root.id, { kind: KINDS.endOfRunTurn, data: { role: "model", text: said }, model: [{ role: "assistant", content: [{ type: "text", text: said }], timestamp: now() }] as never });
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
  /** An error's text as the run's end, its row or the runner's log may say it: cut of every secret the runner holds
   *  (LoopDeps.redact), since a provider's or a computer's error may echo one. */
  const said = (error: unknown): string => {
    const text = (error as Error)?.message ?? String(error);
    return deps.redact ? deps.redact(text) : text;
  };
  let stopped: () => void = () => {};
  const stopping = new Promise<void>((resolve) => (stopped = resolve));
  /** Aborted by any stop of the run (AdapterRun.stopped, with the claim's signal). */
  const stopAbort = new AbortController();
  void stopping.then(() => stopAbort.abort(new Error("the run was stopped")));
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
  /** The run is parking at its cap (the early pause, from its commit on): a raise row is left for the next claim. */
  let pausing = false;
  /** Resolved once the claim's Harness is open and its root known: a command's check reads the journal through it. */
  let opened: () => void = () => {};
  const ready = new Promise<void>((resolve) => (opened = resolve));
  let held: { detach(): void } | undefined;
  /** The run's computer hold's journal side, for the current pass (AdapterRunSpec.computer). */
  let computerNow: JournalHold | undefined;
  /** This claim's spec, once known: a raise is checked by its cap's rule, and the end's patch is read from it. */
  let specNow: AdapterRunSpec | undefined;
  /** Whether this claim's tool host was let go (its beforeRelease run), once. */
  let hostReleased = false;
  /** A tool host's beforeRelease, once per claim: before a park's seal and before the end's commit (the end is the
   *  claim's release), so what it writes (a browser release's charge, its paid booking on run.ledger.paid) lands in its
   *  own commits under the live claim, just before. A hook that throws is logged; the run's end or park stands. */
  const releaseHost = async (on: Harness | undefined): Promise<void> => {
    endWait();
    if (hostReleased || !on) return;
    hostReleased = true;
    for (const stop of specNow?.lifecycle?.beforeRelease ?? []) {
      await Promise.resolve().then(() => stop(on)).catch((error: unknown) => console.warn(`[runner] a tool host's beforeRelease failed: ${(error as Error)?.message ?? String(error)}`));
    }
  };
  /** The current pass's spec's release, until it is called (closeSession). */
  let releaseNow: (() => Promise<void>) | undefined;
  /** While the end-of-run turn runs: a steer is left for the end, and its writes and edits under work/.learning/ are
   *  refused (REFLECT_NOTE_ONLY). */
  let reflecting = false;
  /** While the run's end waits for a person to hand its desktop or phone back (#2134): a steer is left for the end, as
   *  in the end-of-run turn, so no turn starts that the end, written after the hand-back, would cut. */
  let handingBack = false;
  /** A run a person's follow-up reopened (the store's runs.reopen: its journal holds the end of its last turn, its session
   *  opens idle): the follow-up's steer is this claim's turn, sent by steer() as a tracked turn (`sent`), and the claim waits
   *  for it, so the run's next end comes after that turn's answer. Undefined once the claim has read its delivered rows.
   *  Also set while the run waits in its claim on the person's answer to its question (waitInClaim): their message is sent
   *  the same way, as the claim's next turn, and `placed` wakes the wait once it is sent. */
  let reopen: { sent?: Promise<void>; placed?: () => void } | undefined;
  /** The tool hosts' holds while the run waits in its claim on the person's answer (HostLifecycle.personWait): dropped
   *  once the wait is over, whichever way it ends. */
  let waitHolds: PersonWait[] = [];
  /** The wait's own `reopen`, while it is set. */
  let waitTurn: { sent?: Promise<void>; placed?: () => void } | undefined;
  /** A person's message placed as a steer while the session was idle and no wait took it (its turn tracked by no one): the
   *  answer to a question that landed between the question's turn end and the wait's start. The wait takes it as its
   *  answer (waitInClaim), once. */
  let idleSteer: { requestId: string; placed: Promise<boolean> } | undefined;
  /** The wait in the claim is over (an answer placed, a lapse, the run's end, park, restart or loss): its holds go. `of`:
   *  only while it is that wait's (a wait that settles late never ends a later one). */
  const endWait = (of?: object): void => {
    if (of !== undefined && of !== waitTurn) return;
    if (reopen === waitTurn) reopen = undefined;
    waitTurn = undefined;
    for (const hold of waitHolds.splice(0)) {
      try {
        hold.drop();
      } catch (error) {
        console.warn(`[runner] a tool host's person-wait hold failed to drop: ${(error as Error)?.message ?? String(error)}`);
      }
    }
  };
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
  /** The cap the run is held to after a raise: the newest raise entry's (read from the run's root when a claim opens, then
   *  each one this claim's raise commit lands), else none and the spec's figure (its launch's) holds. The spec gives the
   *  launch's cap and nothing more (a raise is a command row, all the server writes), so this is the one place a raise
   *  reaches every admission (runCap's capUsd) and every park (the pending budget's cap), on this claim and any later
   *  one, another runner's included. */
  let raisedCapUsd: number | undefined;
  /** The run's cap now: the newest raise's, else the spec's. */
  const capNow = (): number | undefined => raisedCapUsd ?? specNow?.runCap.capUsd();
  /** The pass's MCP (spec.mcp), until the pass ends; and whether a command row came since its credentials were last made
   *  fresh (a parked token may have expired meanwhile). */
  let mcp: ClaimMcp | undefined;
  let mcpStale = false;

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
    // Parking at its cap: the pause is (being) journaled with the run parked, and this claim ends parked without a
    // follow-up. The row is left untaken, so it wakes the run and the next claim resumes it from the pause.
    if (pausing) return { later: "the run is parking at its cap: the raise resumes it on its next claim" };
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

  /** A hand-back that reaches a loop whose pass is over, or never opened, waits for the run's next claim. */
  const HAND_BACK_LATER = "the run is parking or ending: the hand-back waits for its next claim";
  /** Hand-backs one at a time: each decides on the journal the one before it left, so a second answer meets the first. */
  let handing: Promise<unknown> = Promise.resolve();
  /** A person's answer to the agent's browser hand-over (hand-back.ts): the first for an ask is its answer, committed as
   *  the answered hand-over entry at the row's own time, the row taken in that commit. A row after the ask lapsed writes
   *  the expiry (at the expiry's time) and is refused; one for an ask answered already, or never made, is refused. `later`
   *  when this claim can no longer say, as an approval's (waitsFor): its Harness never opened, or its pass is over. */
  const handBack = (command: Command): Promise<CommandOutcome> => {
    const turn = handing.then(async (): Promise<CommandOutcome> => {
      await Promise.race([ready, (finished ?? new Promise<never>(() => {})).then(() => undefined, () => undefined)]);
      const [theGate, theHarness, theRoot] = [gate, harness, root];
      if (!theGate || !theHarness || !theRoot || theGate.sealed) return { later: HAND_BACK_LATER };
      try {
        return await handBackThrough(command, theGate, theHarness, theRoot);
      } catch (error) {
        // Sealed while it read or wrote: closeSession seals, then closes the Harness the answer went through.
        if (theGate.sealed) return { later: HAND_BACK_LATER };
        throw error;
      }
    });
    handing = turn.catch(() => undefined);
    return turn;
  };
  /** A hand-back's answer, decided and written through the pass's open Harness. */
  const handBackThrough = async (command: Command, theGate: Gate, theHarness: Harness, theRoot: Conversation): Promise<CommandOutcome> => {
    // The person's answer takes its row in the commit that writes it: staged for the answer this row would write (its ask,
    // its outcome, at its own time). Decided and written in one commit (answerOnce), so no other writer's answer (the
    // browser host's give or expiry) lands between: a row whose commit writes nothing, or the ask's expiry, takes none,
    // and the staging matches nothing (an answered ask is never answered again).
    const { ask, outcome } = (command.body ?? {}) as { ask?: unknown; outcome?: unknown };
    const at = new Date(command.createdAt).toISOString();
    const landed = typeof ask === "string" ? theGate.expect(writesEntry(KINDS.handover, (data) => data.id === ask && data.state === outcome && data.at === at), { take: [command.id] }) : undefined;
    landed?.catch(() => undefined);
    const { write, refused } = await answerOnce((change) => theHarness.commit(change, context), theRoot.id, (entries) => handBackOf(entries, command.body, command.createdAt));
    if (write && refused === undefined) await landed;
    return refused === undefined ? { taken: true } : { refused };
  };

  /** A person's take-over or hand-back of the run's desktop or phone (computer-journal.ts): applied to the hold, and taken
   *  by the commit that writes the change it made (its entries carry the row's id); refused in words when it changed
   *  nothing. One at a time, behind the browser's hand-backs' turn: each meets the hold the one before it left. */
  const computerCommand = (command: Command): Promise<CommandOutcome> => {
    const turn = handing.then(async (): Promise<CommandOutcome> => {
      await Promise.race([ready, (finished ?? new Promise<never>(() => {})).then(() => undefined, () => undefined)]);
      const [theGate, journal] = [gate, computerNow];
      if (!theGate || theGate.sealed || !journal) return { refused: "This run has no desktop or phone up now." };
      const outcome = journal.apply(command);
      if (!("taken" in outcome)) return outcome;
      // Registered before the change's commit runs (the hold's writes go out one at a time, after this turn).
      const madeBy = (data: Record<string, unknown>) => journal.madeBy(data, command.id);
      const landed = theGate.expect((batches) => writesEntry(COMPUTER_HOLD_KIND, madeBy)(batches) ?? writesEntry(COMPUTER_HANDOVER_KIND, madeBy)(batches), { take: [command.id] });
      landed.catch(() => undefined);
      await landed;
      return outcome;
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
    // A seal while the commit is in flight (the claim lost) fails it before it is awaited: handled here, read below.
    landed.catch(() => undefined);
    try {
      await harness!.commit((tx) => tx.appendEntry(root!.id, { kind: KINDS.raise, data: data as unknown as JsonValue }), context);
    } catch (error) {
      landed.catch(() => undefined);
      throw error;
    }
    await landed;
    // The raise holds from here, at every admission and park: once its entry is in, never before.
    if (data.capUsd > 0) raisedCapUsd = data.capUsd;
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
    if (handingBack) return { later: "the run has answered and waits for its computer to be handed back before it ends: the steer is not placed" };
    const text = typeof (command.body as { text?: unknown } | null)?.text === "string" ? (command.body as { text: string }).text : "";
    const requestId = commandRequest(command.id);
    // A message that answers nothing (a trigger's, answers: false) waits for the turn's end and runs as a turn of its
    // own, never steering the turn in flight, and never as a waiting call's answer.
    const followUp = (command.body as { answers?: unknown } | null)?.answers === false;
    // The session idle with no wait taking messages yet: whether the last turn ended on a question to the person, read
    // first. It is an await, so a wait may start meanwhile: every path below is chosen after it, with nothing awaited
    // between that choice and the message's placing.
    const askedLast = !reopen && session.state === "idle" && root !== undefined && endedOnTurnEndingTool((await entriesOf(gate.journal, root.id, context)) as never) !== undefined;
    if (!gate || !session || gate.sealed) return { later: "the run is parking: the steer waits for its resume" };
    // A message that may not answer a person (a trigger's), delivered once the run waits on its person (in its claim, or
    // between the question's turn end and that wait): never the wait's answer, never placed, refused in the words the
    // server refuses one with while the run waits (runs-over-store.ts WAITS_ON_A_PERSON).
    if (followUp && (askedLast || (reopen !== undefined && reopen === waitTurn))) return { refused: "The run is waiting on a person." };
    // A reopened run's follow-up, its session idle: sent as a turn of its own, tracked to its end (as the input and a raise's
    // follow-up are), its row taken in its submission's commit; the claim waits on it before the run's next end.
    if (reopen && !reopen.sent && session.state === "idle") {
      const theSession = session;
      // The answer to a wait in the claim: the row's waiting summary goes in its commit.
      const taken = gate.expect(writesSubmission(requestId), { take: [command.id], ...(reopen === waitTurn ? { run: { summary: null } } : {}) });
      taken.catch(() => undefined);
      reopen.sent = (async () => {
        await cliRecord?.person(text);
        await theSession.send(text, { id: requestId });
      })();
      reopen.placed?.();
      try {
        await reopen.sent;
      } catch (error) {
        if (gate.sealed) return { later: "the run is parking: the follow-up waits for its resume" };
        return { refused: `the follow-up was not placed: ${(error as Error).message}` };
      }
      await taken.catch(() => {});
      return { taken: true };
    }
    if (!session.steer) return { refused: "this harness takes no steer mid-turn" };
    // Who wrote it, when the person did not (a trigger's message): carried on its input, as the Timeline shows it.
    const origin = originOf((command.body as { origin?: unknown } | null)?.origin);
    const taken = gate.expect(writesSubmission(requestId), { take: [command.id] });
    // A seal while the steer is placed fails it before it is awaited: handled here.
    taken.catch(() => undefined);
    const theGate = gate;
    // The session idle after a question (askedLast), no wait taking messages yet: this places a turn no one tracks.
    const steering = session.steer(text, requestId, followUp ? "followUp" : "steer", origin ? { origin } : undefined);
    // A person's message (never a trigger's) answering the question the last turn ended on, placed so: kept, so the wait
    // on that question, starting next, takes it as its answer. Any other idle steer is no answer to a wait.
    if (askedLast && !followUp) idleSteer = { requestId, placed: steering.then(() => true, () => false) };
    try {
      await steering;
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
    const signalAbort = () => {
      gate?.seal(new Interrupted("its claim's signal aborted"));
      // A lost claim's MCP credentials go at once, a call still out among them.
      mcp?.release();
    };
    deps.signal.addEventListener("abort", signalAbort, { once: true });
    let fault: KernelFault | undefined;
    try {
      passes: for (let restarts = 0; ; restarts += 1) {
        fault = undefined;
        gate = new Gate(deps.journal(claim));
        if (deps.signal.aborted) gate.seal(new Interrupted("its claim's signal aborted"));
        const registry = createRegistry();
        let models: Models = createModels();
        // The spec's phases said before the run's root exists (AdapterRun.phase), written in the root's creating commit.
        const phasesBeforeRoot: { summary: string; at: number }[] = [];
        let rootMade = false;
        // A root made by a phase while the spec was built (below), before the spec's own lifecycle was known: its
        // onConversation writes for the root are owed (RootWritesOwed, on the root), made once the spec is (after specOf).
        let specKnown = false;
        /** The root a phase is making, awaited before the owed writes are read. */
        let rootMaking: Promise<unknown> | undefined;
        harness = await Harness.open(gate.journal, {
          models: () => models, registry, settings: { restartLimit }, onReport: () => {},
          // A tool host's onConversation, in each agent conversation's creating commit (the spec's, once it is known: the
          // root is created when the session opens, after the spec).
          conversationCreated: async (tx, record) => {
            if (!agentConversation(record)) return;
            if (Number(record.id) === Number(ROOT_CONVERSATION_ID)) {
              rootMade = true;
              for (const data of phasesBeforeRoot.splice(0)) await tx.appendEntry(record.id, { kind: HOST_PHASE, data });
              if (!specKnown) {
                (await tx.doc(RootWritesOwed, record.id)).owed = true;
                return;
              }
            }
            for (const write of specNow?.lifecycle?.onConversation ?? []) await write(tx, Number(record.id));
          },
        }, context);
        // The run's one cap, on its own sessions, built once its spec gives the cap's config (spec.runCap); its handles are
        // made here, before the spec, so the spec's tool host binds them at its bind (a browser release's charge comes
        // outside any call). Each session is opened at its first step: a run that makes none writes nothing for it. A
        // handle not opened on this claim reads what the run's records held when the claim began.
        const sessions = journalSessions(harness, context, { flush: () => deps.flush() });
        let capBuilt: RunCap | undefined;
        const theCap = (): RunCap => {
          if (!specNow?.runCap) throw new Error("the run's spec gives no cap (AdapterRunSpec.runCap)");
          // The cap each admission reads is the run's now (capNow): a raise taken on this claim or an earlier one.
          return (capBuilt ??= runCap({ sessions, ...specNow.runCap, capUsd: capNow }));
        };
        const flushed = { flush: () => deps.flush() };
        const earlierDecisions = sessionSpendOf(await sessions.read(DECISION_SESSION)).spentUsd;
        const earlierPaid = sessionSpendOf(await sessions.read(TOOL_SESSION)).spentUsd;
        let decisionsReady: RunDecisions | undefined;
        let decisionsOpen: Promise<RunDecisions> | undefined;
        const decisionsOf = () => (decisionsOpen ??= sessions.open(DECISION_SESSION).then((w) => theCap().decisions(w, flushed)).then((d) => (decisionsReady = d)));
        let paidReady: RunTools | undefined;
        let paidOpen: Promise<RunTools> | undefined;
        const paidOf = () => (paidOpen ??= sessions.open(TOOL_SESSION).then((w) => theCap().tools(w, flushed)).then((p) => (paidReady = p)));
        /** The pause of a paid call the cap refused (ledger.pause), set once the claim's booking is: below. */
        let pauseFor: ((refusal: Refusal) => Promise<void>) | undefined;
        const ledger: RunLedger = {
          decisions: {
            admit: async (request) => (await decisionsOf()).admit(request),
            settle: async (id, settled) => (await decisionsOf()).settle(id, settled),
            spentUsd: () => (decisionsReady ? decisionsReady.spentUsd() : earlierDecisions),
            heldUsd: () => decisionsReady?.heldUsd() ?? 0,
          },
          paid: {
            admit: async (request) => (await paidOf()).admit(request),
            settle: async (id, usd, options) => (await paidOf()).settle(id, usd, options),
            spentUsd: () => (paidReady ? paidReady.spentUsd() : earlierPaid),
            heldUsd: () => paidReady?.heldUsd() ?? 0,
          },
          // Lazy, as main's process takes them (portModels(() => sessionPort?.(...))): a spec takes them at its build, and
          // each request reads the session's port then, there once the session is open.
          models: (label) => portModels(() => session?.port?.(label)),
          pause: async (refusal) => {
            await pauseFor?.(refusal);
          },
        };
        // A phase of the host's, on the run's timeline while its step runs. Said before the root exists (the claim's computer
        // waiting on its image build, inside specOf), it makes the root then, the row in its creating commit (above), so a
        // person sees the row during the wait, and a failed step keeps it (run()'s catch writes the end on that root). The
        // session opens onto that root later and sets its agent there (pi.ts configures it on every open). Else at once.
        const phasing = harness;
        const phase = (summary: string): void => {
          const data = { summary, at: Date.now() };
          void (async () => {
            if (!rootMade && !(await phasing.conversation(ROOT_CONVERSATION_ID, context)) && !rootMade) {
              phasesBeforeRoot.push(data);
              rootMaking = phasing.root(context);
              await rootMaking;
              // The root was made by another write meanwhile (its creating commit took none of these): written now.
              const left = phasesBeforeRoot.splice(0);
              if (left.length === 0) return;
              await phasing.commit(async (tx) => {
                for (const one of left) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: HOST_PHASE, data: one });
              }, context);
              return;
            }
            await phasing.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: HOST_PHASE, data }), context);
          })().catch((error: unknown) => console.warn(`[runner] a phase row was not written: ${said(error)}`));
        };
        const passGate = gate;
        const rowSummaryOn = (kind: string, test: (data: Record<string, unknown>) => boolean, summary: string | null): void => {
          if (passGate.sealed) return;
          passGate.expect(writesEntry(kind, test), { run: { summary } }).catch(() => undefined);
        };
        const runOf: AdapterRun = { harness, registry, setModels: (given) => (models = given), ledger, ...(deps.redact ? { redact: deps.redact } : {}), signal: deps.signal, stopped: AbortSignal.any([deps.signal, stopAbort.signal]), phase, rowSummaryOn };
        // The spec, its MCP claim step among it (mcpForClaim, before the session opens). A refusal there ends the run in its
        // words with nothing sent; a claim lost during its refresh ends the loop with nothing more written. A claim the spec
        // refuses (ClaimRefused: a handed sign-in that won't read back) ends the run in its words too.
        let spec: AdapterRunSpec;
        try {
          spec = await specOf(claim, runOf);
        } catch (error) {
          if (error instanceof Fenced) return await interrupted("its claim was lost while its MCP credentials were made fresh");
          if (error instanceof McpClaimRefused) return await writeEnd(harness, await harness.root(context), gate, { state: "failed", summary: error.message }, []);
          if (error instanceof ClaimRefused) return await writeEnd(harness, await harness.root(context), gate, { state: "failed", summary: error.message }, []);
          // A person's stop while the spec was built (it waited on a harness's install): the run ends stopped, in the stop's
          // words, its row taken; the work it waited on goes on for the next run. A stop wins over the build's own failure.
          if (stopReason?.kind === "command") return await writeEnd(harness, await harness.root(context), gate, { state: "stopped", summary: endedBy(stopReason.cancel) }, [stopReason.commandId]);
          // A spec that failed after a phase made the run's root (its computer's image build failed): the end goes on that
          // root with why (said: cut of every secret the runner holds), as run()'s catch writes it once the session's root
          // is known, so the timeline keeps the phase row and reads the failure after it.
          await rootMaking?.catch(() => undefined);
          if (rootMade && claim.from !== "parked" && !gate.sealed && !deps.signal.aborted) {
            const ended = await writeEnd(harness, await harness.root(context), gate, { state: "failed", summary: said(error) }, []).catch(() => undefined);
            if (ended) return ended;
          }
          throw error;
        }
        mcp = spec.mcp;
        specNow = spec;
        specKnown = true;
        // The spec's resources are the pass's from here: a claim lost in any write below still lets them go (closeSession).
        releaseNow = spec.release;
        // A root a phase made while the spec was built (on this claim or an earlier one lost before this point) took none
        // of the spec's onConversation writes: they are made now, in a commit of their own, before anything of the
        // session's. A root still being made is waited for first (made from here on, its creating commit takes them itself).
        await rootMaking?.catch(() => undefined);
        if (await harness.conversation(ROOT_CONVERSATION_ID, context)) {
          await harness.commit(async (tx) => {
            const owed = await tx.doc(RootWritesOwed, ROOT_CONVERSATION_ID);
            if (!owed.owed) return;
            owed.owed = false;
            for (const write of spec.lifecycle?.onConversation ?? []) await write(tx, Number(ROOT_CONVERSATION_ID));
          }, context);
        }
        // A mark of the run's commits through its own Harness, under its fence.
        const opened_ = harness;
        spec.harnessReady?.((change, ctx) => opened_.commit(change, ctx));
        // A tool host's beforeResume: the Harness is open and nothing in it has resumed (pi schedules a task only once a
        // submit, a wait or the session's open asks for progress, all below).
        for (const settle of spec.lifecycle?.beforeResume ?? []) await settle(harness);
        const hooks = spec.hooks ?? quiet;
        const writer = await sessions.open(spec.session.key);
        // Every paid request of the run is asked of its one cap (theCap: one rule, one admission queue, the run's totals
        // over every session of it): its model requests here, its paid tool calls (ledger.paid, under each call below and
        // outside any) and its decisions (ledger.decisions). Its last refusal is kept: a turn it ended ends the run in its
        // words.
        const paid = ledger.paid;
        let refused: Refusal | undefined;
        /** The pause a refusal for room journaled before pi heard of it (pauseAtCap), the run parked with it. */
        let pausedAtRefusal = false;
        /** A paid call's refusal that pauses the run (ledger.pause): the run's next request is refused in its words. */
        let pendingPause: Refusal | undefined;
        const beforeRequest: BeforeRequest = async (request) => {
          const answer = pendingPause ?? (await theCap().before(request));
          if (answer && "refuse" in answer) {
            refused = answer;
            await pauseAt(answer);
          }
          return answer;
        };
        pauseFor = async (refusal) => {
          pendingPause = refusal;
          await pauseAt(refusal);
        };
        async function pauseAt(answer: Refusal): Promise<void> {
          {
            // A refusal a raise could fix (the cap's rule, parkOf) journals its pause, the run parked, before the refusal
            // reaches pi: pi stores the refused turn only after it, so a claim lost in between leaves the pause, and the next
            // claim resumes the run parked (an unanswered pause), never ends it as a failed turn. One that cannot land (the
            // journal sealed) is left to the turn's end, as before.
            const park = spec.cap?.park(refusalOf(answer), raisedCapUsd ?? spec.cap.capUsd);
            if (park?.outcome === "parked" && !pausedAtRefusal && harness && gate && !gate.sealed) {
              const on = gate;
              // From here a raise row waits for the next claim (raise): one taken now would answer no pause this claim
              // resumes, and the run would be left parked with nothing to wake it.
              pausing = true;
              try {
                await pauseAtCap(harness, root ?? (await harness.root(context)), on, { pending: park.pending, words: park.words });
                pausedAtRefusal = true;
              } catch {
                // Not landed: the turn's end parks the run, or the claim's next holder does.
              }
            }
          }
        }
        // The rule before a side effect for every paid model request, on the path every adapter's requests take: the
        // booking writes the request's record, then awaits request_start before the request leaves, so the flush here
        // makes that record and everything before it durable first (each send, a retry's included).
        const booking = await modelPortFor(writer, {
          key: spec.session.key,
          label: spec.session.label,
          beforeRequest,
          onEvent: async (event) => {
            if (event.type === "request_start") await deps.flush();
          },
        });
        // A paid request an earlier claim admitted and never saw answered (its runner lost while the request was out): the
        // provider may have billed it, so it is booked once, as cut, at its hold and bound, and told as any answered request
        // is, before this claim sends anything (the harness runner's bookCut, main's cut booking).
        await booking.bookCut();
        const gateOf = preIntentGate(spec, hooks);
        // A CLI's run: the loop keeps its visible record (record: "loop"), every call a crash or a fault left open ended.
        const record = spec.record === "loop" ? await openCliRecord(harness, gate.journal, context, now) : undefined;
        cliRecord = record;
        // Each tool the session runs on the host, the host's own and any its adapter adds (SessionIO.hostTool: a CLI's
        // read_skill_file), the same way: a CLI's call on its record, so the run's Timeline shows it and its result.
        const hosted = (tool: HostTool): HostTool => ({
          ...tool,
          // The rule before a side effect, on the host-tool path every adapter's calls take: after the call's intent, a
          // flush unless the tool is replay-safe, the call, then the beforeResult point. A throw there is the kernel's own
          // fault: the journal is sealed before the harness's result commit, so the Session fails with the call before
          // its result, and the loop restarts it. A CLI's call reaches here only once the gate allowed it (its tool
          // bridge asks first), so its record's start is written here, before the flush and the call, and its end after.
          call: async (args, toolContext) => {
            // A call its CLI issues again under an id the record already ended (after the CLI's own resume) is answered
            // from that end, never run again.
            const ended = record?.endOf(toolContext.callId);
            if (ended) return endedAnswer(tool.name, ended);
            if (record) await record.start(toolContext.callId, tool.name, args ?? {}, tool.replay === "safe");
            try {
              const answer = await sideEffect({
                replaySafe: tool.replay === "safe",
                flush: () => deps.flush(),
                // Its paid requests booked under this call, on the run's one ledger (paid-calls.ts bookedIn, Ledger.paid); one
                // refused for room pauses the run (Ledger.pause, the run's pause), as main's paidCall does.
                route: () => bookedIn({ call: toolContext.callId, record: async () => {}, paid, pause: ledger.pause }, () => tool.call(args, toolContext)),
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
        });
        const tools: HostTool[] = [...spec.session.tools, ...(mcp?.tools ?? [])].map(hosted);
        // The session's model port, counting what it admitted and has not booked yet (a stop's booking comes once the
        // session's proxy sees its upstream end, which can be after pi went idle).
        const port = booking.models;
        unbooked = 0;
        const counted: typeof port = {
          beforeRequest: async (request) => {
            // A command row since the MCP credentials were made fresh: made fresh again before this request.
            if (mcpStale && mcp) {
              mcpStale = false;
              await mcp.fresh();
            }
            const ticket = await port.beforeRequest(request);
            unbooked += 1;
            return ticket;
          },
          afterRequest: async (...args) => {
            try {
              await hooks.beforeBooking?.();
              await port.afterRequest(...args);
            } finally {
              unbooked = Math.max(0, unbooked - 1);
              if (unbooked === 0) for (const wake of bookedAll.splice(0)) wake();
            }
          },
          ...(port.responded ? { responded: port.responded.bind(port) } : {}),
          ...(port.note ? { note: port.note.bind(port) } : {}),
        };
        // What the request that just answered cost, once the session's requests are booked (bookingOfAnswer): its own
        // booking's figure, null when unknown; a side request's is given and never read. A refused request's record is its $0.
        // The bookings already given to an answer: every one the session holds when it opens (an earlier claim's), then each
        // this claim gives.
        const given = new Set(turnsOf(await writer.read().catch(() => [] as SessionRecord[])));
        const bookedCost = async (): Promise<number | null | undefined> => {
          await bookingsSettled();
          const booking = bookingOfAnswer(await writer.read().catch(() => [] as SessionRecord[]), given);
          for (const turn of booking.turns) given.add(turn);
          return booking.usd;
        };
        const io: PiSessionIO = { writer, models: counted, signal: deps.signal, onEvent: record ? (event) => record.onEvent(event) : () => {}, gate: gateOf, hostTool: hosted, bookedCost };
        // The MCP tools: pi's own (host tools, through the gate above); for a harness with its own MCP client, the session's
        // MCP its adapter mounts on its proxy, each call asking the gate first (an ask parks the run, nothing sent).
        const mcpNames = new Set(mcp?.tools.map((tool) => tool.name));
        const ownClient = mcp !== undefined && spec.adapter.capabilities().mcpClient !== undefined;
        const sessionMcp = ownClient
          ? mcp!.session(new Map(tools.filter((tool) => mcpNames.has(tool.name)).map((tool) => [tool.name, tool])), async (call) => {
              const answer = await gateOf(call, context);
              return answer === "allow" ? undefined : "deny" in answer ? { refused: answer.deny } : { parked: true as const };
            })
          : undefined;
        session = await spec.adapter.open({ ...spec.session, tools: ownClient ? tools.filter((tool) => !mcpNames.has(tool.name)) : tools, ...(sessionMcp ? { mcp: sessionMcp } : {}) }, io);
        root = await harness.root(context);
        // The run's desktop or phone: its hold's changes go to the run's journal, through this pass's Harness (under its
        // fence), and the computer shows up, the agent driving.
        computerNow?.detach();
        computerNow = undefined;
        if (spec.computer) {
          const [journalOf, rootOf] = [harness, root];
          computerNow = journalHold(claim.runId, spec.computer, (entries) => journalOf.commit(async (tx) => {
            for (const entry of entries) await tx.appendEntry(rootOf.id, { kind: entry.kind, data: entry.data as unknown as JsonValue });
          }, context), now);
          await computerNow.up();
        }
        // The cap a raise left the run at, from its root (the newest raise entry), before any request of this claim: a
        // claim that takes over a raised run (a resume, another runner's) holds it to the raise, never the launch's cap.
        if (spec.cap) raisedCapUsd = (await raiseStateOf()).lastRaise?.to ?? raisedCapUsd;
        // A run brought back from a park: the raises its claim has are taken together, once its delivery is done. So is a
        // run whose journal still holds an unanswered budget pause, whatever its row said at the claim: a resumed claim lost
        // before its raise entry landed leaves the run running, its pause unanswered and its raises untaken.
        if (restarts === 0 && (claim.from === "parked" || (spec.cap?.checkRaise !== undefined && (await raiseStateOf()).pause !== undefined))) {
          raising.resuming = true;
          raising.state ??= await raiseStateOf();
        }
        // Taken over from a runner whose lease ran out mid-run: said on the run's timeline once, at this claim's first pass.
        if (restarts === 0 && claim.lost) await noteTakenOver(harness, root, claim.lost.runner);
        // Reopened by a person's follow-up (runs.reopen): its journal holds an end and its session opens idle. Set before the
        // session is ready, so the follow-up's steer, handed over once it is, is sent as this claim's turn.
        if (restarts === 0 && session!.state === "idle" && (await entriesOf(gate.journal, root.id, context)).some((entry) => entry.kind === KINDS.end)) reopen = {};
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
          // A person's stop or cancel that woke the parked run is its end, before any park again: given back parked on
          // the same budget, its stop untaken, the run would be claimed again at every poll and never end (#2204). It
          // ends as a stop does mid-turn: in the stop's words, its row taken, with what the end-of-run step keeps of a
          // cut run.
          if (stopReason?.kind === "command") {
            return await writeEnd(harness, root, gate, { state: "stopped", summary: endedBy(stopReason.cancel) }, [stopReason.commandId], await cutRows(claim, spec, "stopped"));
          }
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
        if (!followedUp && ownClient) {
          // MCP calls a harness with its own client parked through the door: each answered once (an allow runs it, a deny
          // is told), then the session goes on with main's resume message for them, written on the record before it is
          // sent (as the person's input is). A call still waiting parks the run again.
          const wrapped = new Map(tools.map((tool) => [tool.name, tool]));
          const follow = await parkedFollowUp(mcp!, {
            entries: await entriesOf(gate.journal, root.id, context),
            answer: (call, price) => answerOf(call, price),
            deniedNow: async (call) => {
              // The gate is Promise-capable on purpose (run-cap's and the approvals' gates may look things up), so await it.
              const now = await spec.gate?.({ callId: call.callId, tool: call.tool as never, args: call.args });
              return now === "deny" ? setToDenyText(call.tool) : typeof now === "object" ? now.deny : undefined;
            },
            run: (call) => wrapped.get(mcp!.tools.find((tool) => mcp!.catalogOf(tool.name) === call.tool)!.name)!.call(call.args, { callId: call.callId, signal: deps.signal }),
          });
          if (follow === "park") {
            gate.seal(new Parked());
            return { state: "parked" };
          }
          if (follow) {
            const theRoot = root;
            await harness.commit((tx) => tx.appendEntry(theRoot.id, { kind: KINDS.message, data: { role: "person", text: follow.text, origin: { kind: "server", reason: "approval" }, at: now() } as unknown as JsonValue }), context);
            await session!.send(follow.text, { id: `agentrun:approval:${follow.callIds[0]}` });
            followedUp = true;
          }
        }
        if (reopen) {
          // Every row the runner read for this claim has reached its command() (deps.delivered): the follow-up's steer, sent
          // by steer() as a turn, is the turn this claim runs. With none (a claim after that turn's answer), it ends again.
          await deps.delivered;
          // A steer handed over waits on the session's readiness (resolved above) before it sends: one turn of the event loop
          // lets it get there.
          await new Promise<void>((resolve) => setImmediate(resolve));
          const sent = reopen.sent;
          reopen = undefined;
          if (sent) {
            await sent.catch(() => undefined);
            followedUp = true;
          }
        }
        // A claim that starts a turn (the input, a recovery, a follow-up) waits for that turn's end: state is the session as
        // open found it, and a CLI adapter reads idle once its turn is sent, so state read after a send says nothing.
        const placed = followedUp || session!.state !== "idle";
        if (followedUp) {
          // The follow-up is the turn this claim runs.
        } else if (session!.state === "new") {
          // A trigger's first input is its origin's (the launch's), never written as the person's.
          if (spec.inputOrigin) await record?.input(spec.input, spec.inputOrigin);
          else await record?.person(spec.input);
          await session!.send(spec.input, spec.inputOrigin ? { origin: spec.inputOrigin } : undefined);
        }
        else if (session!.state === "open_turn") await session!.recover();
        // The turn this claim waits on: the first, then each the person's answer starts while the run waits in its claim on
        // its question (waitInClaim: ask_person with the browser open); "lapsed" when such a wait can no longer hold.
        let turn: Promise<TurnEnd | "lapsed"> = placed ? session!.turnEnd() : idleTurnOf(harness, root);
        // Set on every way out of the loop below but parkOn's, which returns before it is read.
        let data!: EndData;
        let failedWith: string | undefined;
        /** The ask_person call the run parks on, its turn ended on it and no wait in the claim holding (parkOnAsk). */
        let parkOn: string | undefined;
        /** The ask_person call the run waits on in its claim, while it does. */
        let waitingOn: string | undefined;
        for (;;) {
          const end = await Promise.race([turn.then((ended) => (ended === "lapsed" ? ("lapsed" as const) : ("answered" as const))), parking.then(() => "parked" as const), stopping.then(() => "stop" as const), harness.closed.then(() => "closed" as const)]);
          if (end === "parked") {
            // Let the tool host go first (a browser's release, booked under the live claim), then seal.
            await releaseHost(harness);
            gate.seal(new Parked());
            return { state: "parked" };
          }
          if (end === "closed" && fault && !stopReason && !deps.signal.aborted) {
            await closeSession();
            continue passes;
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
          // The wait in the claim lapsed before the person answered (the cap had no room for more of their time, or the browser
          // it kept went): the run parks on its question, as it does with nothing open.
          if (end === "lapsed") {
            parkOn = waitingOn;
            break;
          }
          const outcome = (await turn) as TurnEnd;
          // What the model said last, on the record before the run's end.
          await record?.flushText();
          await harness.waitForIdle(context);
          const settledEntries = await entriesOf(gate.journal, root.id, context);
          const cutOff = restartLimited(settledEntries);
          if (cutOff) data = { state: "failed", summary: `a tool call faulted on every restart: ${cutOff}` };
          else if (outcome.status !== "completed" && refused) {
            // A turn the host's check refused: what that does to the run is the cap's rule (parkOf), as on main. A refusal a
            // raise could fix parks the run on a raise; one no raise could fix (or a check with no cap) fails it, in the
            // check's own words, never as a run with no answer.
            const park = spec.cap?.park(refusalOf(refused), raisedCapUsd ?? spec.cap.capUsd);
            if (park?.outcome === "parked" && pausedAtRefusal) {
              // Its pause and the run parked landed before pi heard of the refusal.
              await releaseHost(harness);
              gate.seal(new Parked());
              return { state: "parked" };
            }
            if (park?.outcome === "parked") return await parkAtCap(harness, root, gate, { pending: park.pending, words: park.words });
            data = { state: "failed", summary: park?.outcome === "failed" ? park.error : refused.refuse };
          } else if (outcome.status !== "completed") {
            // A turn that ended on its harness's own error (a CLI's: a codex run whose MCP door could not be reached) fails
            // the run in those words, bounded; serve redacts a run's summary as it serves it, as every summary. With none,
            // the loop's own words.
            const said = outcome.error?.trim();
            data = { state: "failed", summary: said ? cutWhole(said, TURN_ERROR_MAX) : `the run gave no answer (${outcome.status})` };
            // A CLI's turn (record "loop"; pi journals its own): its error is also main's error row, pi's error answer in the
            // end's commit, cut of every secret the runner holds, so the timeline shows it as an error row with no key in it.
            if (said && spec.record === "loop") failedWith = deps.redact ? deps.redact(said) : said;
          }
          else if (endedOnTurnEndingTool(settledEntries as never) !== undefined) {
            // The turn ended on a tool that waits on the person (ask_person ended its turn). With something a tool host keeps
            // open for them meanwhile (the browser's session, its live view and its page), the run waits for their answer in
            // its claim, as the browser's hand-over does, the person's time held under its cap (waitInClaim); their answer is
            // its next turn, on the same session. With nothing open, it parks (parkOnAsk).
            const callId = endedOnTurnEndingTool(settledEntries as never)!;
            const waited = await waitInClaim(harness, callId);
            if (waited) {
              turn = waited.next;
              waitingOn = callId;
              continue;
            }
            parkOn = callId;
          }
          else {
            // An answer cut at the model's output limit is unfinished: the run fails, saying so, never ended (loop.ts cutLast,
            // the direct loop's rule: the words are loop-contract's cutAtLimit).
            const cut = cutLast(settledEntries);
            data = cut ? { state: "failed", summary: cut } : { state: "ended" };
          }
          break;
        }
        if (parkOn !== undefined) return await parkOnAsk(harness, root, gate, parkOn);
        // A person who holds the run's desktop or phone keeps it (#2134): the run's end, and its computer's release after
        // it, wait for the hand-back or the hold's idle bound, the Timeline saying why. A stop ends the run stopped at
        // once, and a lost claim or a closing runner leaves it for the next claim, as during the end-of-run step.
        if (computerNow) {
          const aborted = new Promise<void>((resolve) => (deps.signal.aborted ? resolve() : deps.signal.addEventListener("abort", () => resolve(), { once: true })));
          // Until the run returns: a steer after the hand-back would start a turn its end then cuts, too.
          handingBack = true;
          await computerNow.heldAtEnd(Promise.race([stopping, aborted, harness.closed]));
          // Set by stop() during the wait: read past the narrowing TypeScript did before it.
          const cut = stopReason as StopReason | undefined;
          if (cut?.kind === "command") return await writeEnd(harness, root, gate, { state: "stopped", summary: endedBy(cut.cancel) }, [cut.commandId], await cutRows(claim, spec, "stopped"));
          if (cut || deps.signal.aborted) return await interrupted(cut?.kind ?? "its claim's signal aborted");
        }
        // The end-of-run step, once, before the end: its rows ride in the end commit. A stop or a lost claim during it
        // writes no end of the job's (a person's stop ends the run stopped; a lost claim leaves it for the next claim).
        const step = await endOfRunStep(claim, spec, data.state === "failed" ? "failed" : "completed");
        if (step.kind === "stopped") return await writeEnd(harness, root, gate, { state: "stopped", summary: endedBy(stopReason?.kind === "command" ? stopReason.cancel : undefined) }, [step.commandId], await cutRows(claim, spec, "stopped-looking"));
        if (step.kind === "interrupted") return await interrupted(stopReason?.kind ?? "its claim's signal aborted");
        return await writeEnd(harness, root, gate, data, [], step.also, failedWith);
      }
    } catch (error) {
      if (gate?.sealed || deps.signal.aborted) return await interrupted("its claim's signal aborted");
      // A failure with no end written yet. While the journal still takes a commit, the run's end is written with why (the
      // run patch in that commit), so the journal and the live view read it failed too. A parked run brought back is never
      // failed by its resume: thrown, it stays parked and is tried again after a backoff, as is any failure whose end could
      // not be written (pi's Harness could not open): the runner stores that one failed with why. Returning "failed" with
      // no end would leave it running, released and claimed again at once.
      if (claim.from !== "parked" && harness && root && gate && !gate.sealed) {
        // Why, cut of every secret the runner holds (said): it is stored in the end and the row.
        const ended = await writeEnd(harness, root, gate, { state: "failed", summary: said(error) }, [], specNow ? await cutRows(claim, specNow, "faulted") : []).catch(() => undefined);
        if (ended) return ended;
      }
      throw error;
    } finally {
      deps.signal.removeEventListener("abort", signalAbort);
      held?.detach();
      computerNow?.detach();
      computerNow = undefined;
      handingBack = false;
      deps.live?.(() => undefined);
      // A tool host's beforeRelease, when no end or park let it go first (a shutdown, a lost claim): the Harness still open.
      // A restart within the claim is no release. What it writes after a lost claim is refused by the fence, as any write.
      await releaseHost(harness);
      await closeSession();
    }
  }

  /** The gate before a call's intent: the kernel's beforeIntent point, then allow, deny, or ask (answered, or park). */
  function preIntentGate(spec: AdapterRunSpec, hooks: KernelHooks) {
    return async (call: PreIntentCall, _hookContext: Context): Promise<PreIntentAnswer> => {
      // An MCP tool is asked about by its catalog name (`mcp:<server>/<tool>`), as its settings and its card name it.
      const tool = mcp?.catalogOf(call.tool) ?? call.tool;
      const kernelCall: ToolCall = { callId: call.callId, tool: tool as never, args: call.args };
      // The end-of-run turn's notes are kept only from its answer: a write there is refused before its intent.
      if (reflecting && WRITES.has(call.tool) && underLearning(spec.workRoot, call.args)) return { deny: REFLECT_NOTE_ONLY };
      await hooks.beforeIntent(kernelCall);
      const decision = (await spec.gate?.(kernelCall)) ?? "allow";
      if (typeof decision === "object") return { deny: decision.deny };
      // Asked about by the name the gate gives (its settings key, as main's pending approval is named), else the call's own;
      // an MCP call by its catalog name (tool) either way, never pi's wire name, and so are its call and its price.
      const asked = spec.gate?.askedAs?.(tool) ?? tool;
      // Main's words for a tool set to deny (tool-gate's deniedText, from its one copy in refusal-words.ts).
      if (decision === "deny") return { deny: setToDenyText(asked) };
      if (decision === "allow") return "allow";
      const answer = await answerOf({ ...call, tool }, mcp?.priceOf(tool) ?? spec.approvalPrice?.(kernelCall) ?? null, asked);
      if (answer === "park") return { park: true };
      return answer.approved ? "allow" : { deny: deniedText(asked, answer.note) };
    };
  }

  /** An ask's answer: one in the journal stands; else the approve or deny the runner hands over on a resume; else ask and
   *  park (the ask entry with the run parked, in one commit). The ask is main's approval card: the call's input, when it
   *  was asked and its `price`; asked again on a resume, it is the same request. */
  async function answerOf(call: PreIntentCall, price: ApprovalPrice | null, asked: string = call.tool): Promise<AnswerData | "park"> {
    const conversation = await harness!.root(context);
    const entries = await entriesOf(gate!.journal, conversation.id, context);
    const known = findData<AnswerData>(entries, KINDS.answer, (data) => data.callId === call.callId);
    if (known) return known;
    const first = findData<AskData>(entries, KINDS.ask, (data) => data.callId === call.callId);
    // The ask names the call as the person is asked about it (`asked`: its settings key), so every reader of the ask (the
    // run's pending approval, its approval row, an "always" answer pinned by it) has the one name main gives it.
    const ask: AskData = first ?? { callId: call.callId, tool: asked, args: call.args ?? null, requestedAt: isoNow(), price };
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
        const data: AnswerData = { callId: call.callId, approved, decision: approved ? "allow" : "deny", answeredAt: isoNow(), ...noteOf(row), ...((row.body as { by?: unknown } | null)?.by === "message" && !approved ? { by: "message" as const } : {}) };
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

  /** Whether a call of this run waits for the answer `approval` names: asked, and not answered yet. `later` when this
   *  claim can no longer say: its Harness never opened, or its pass is parking, ending or stopping (the journal sealed,
   *  closeSession closing the Harness behind the seal). The row is left untaken and the run's next claim checks it, as a
   *  steer that comes as the run parks is (#2292: the read went through the closed Harness and threw). */
  async function waitsFor(approval: string | undefined): Promise<boolean | "later"> {
    if (approval === undefined) return false;
    await Promise.race([ready, (finished ?? new Promise<never>(() => {})).then(() => undefined, () => undefined)]);
    const [theGate, theHarness] = [gate, harness];
    if (!theGate || !theHarness || theGate.sealed) return "later";
    try {
      const conversation = await theHarness.root(context);
      const entries = await entriesOf(theGate.journal, conversation.id, context);
      const asked = findData<AskData>(entries, KINDS.ask, (data) => data.callId === approval) !== undefined;
      return asked && findData<AnswerData>(entries, KINDS.answer, (data) => data.callId === approval) === undefined;
    } catch (error) {
      // Sealed while it read: closeSession seals, then closes the Harness the read went through.
      if (theGate.sealed) return "later";
      throw error;
    }
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

  /** The run parks on its question to the person (ask_person ended its turn), nothing open for them meanwhile: a
   *  KINDS.personAsked entry naming that call carries the run patch to "parked" (as the cap park commits its pause on a
   *  budget entry), so the runner leaves it for the person's message and never claims it again with nothing to answer; the
   *  reader passes the entry over, and input_required with its question is the view's to read (the same
   *  endedOnTurnEndingTool rule, over the ask_person call pi wrote). First write wins, so a second claim finding it does
   *  not write it again. Then the cap park's move: the claim released, nothing more booked. The person's reply arrives as
   *  the run's next user message and resumes it on the next claim, as on main: the ask_person tool result stays what pi
   *  wrote, so nothing is re-asked or re-billed. The summary is plain words, never the question. */
  async function parkOnAsk(on: Harness, conversation: Conversation, theGate: Gate, callId: string): Promise<LoopEnd> {
    const parkedAt = theGate.expect(writesEntry(KINDS.personAsked, (entry) => entry.callId === callId), { run: { state: "parked", summary: ASK_PERSON_WAITING } });
    parkedAt.catch(() => undefined);
    await on.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.personAsked, data: { callId } }), context);
    await parkedAt;
    await releaseHost(on);
    theGate.seal(new Parked());
    return { state: "parked" };
  }

  /** The row's waiting summary of a wait in the claim, gone: its answer came by a way whose commit did not clear it. */
  async function notWaiting(on: Harness, theGate: Gate, conversation: Conversation, callId: string): Promise<void> {
    const cleared = theGate.expect(writesEntry(KINDS.personAsked, (data) => data.callId === callId && data.answered === true), { run: { summary: null } });
    cleared.catch(() => undefined);
    await on.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.personAsked, data: { callId, inClaim: true, answered: true } }), context);
    await cleared;
  }

  /** How the claim's turn ended when its session opened idle: a person's message the run took as a turn of its own (a
   *  wait's answer, a reopened run's follow-up, a parked question's answer: request ids commandRequest makes) that an
   *  earlier claim placed, whose turn this claim resumed, ends as that submission ended, never read as completed when it
   *  failed; with none such newest, completed, as before. */
  async function idleTurnOf(on: Harness, conversation: Conversation): Promise<TurnEnd> {
    const page = await gate!.journal.scanSubmissions({ conversationId: conversation.id, order: "descending" }, 10, undefined, context);
    const last = page.items.find((submission) => submission.type === "input");
    if (!last?.requestId?.startsWith(COMMAND_REQUEST_PREFIX)) return { status: "completed" };
    return turnOfRequest(on, conversation, last.requestId);
  }

  /** How the turn of the root's submission `requestId` ended (a steer of the idle session, which no session tracks). */
  async function turnOfRequest(on: Harness, conversation: Conversation, requestId: string): Promise<TurnEnd> {
    const found = await on.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context);
    if (!found) {
      await on.waitForIdle(context);
      return { status: "completed" };
    }
    const submission = await on.submission(found.id, context);
    const record = submission ? await submission.wait(context) : undefined;
    return { status: !record || record.status === "done" ? "completed" : "failed" };
  }

  /** The run waits in its claim on the person's answer to its question (ask_person `callId` ended its turn) when a tool
   *  host keeps something open for them meanwhile (HostLifecycle.personWait: the browser's session, whose live view the
   *  person may watch or take over, and whose page the agent goes on from), as the browser's hand-over waits in the claim.
   *  Each host's hold holds the person's time under the run's cap. The run reads input_required, waiting on the question,
   *  from its journal as a parked one does; its claim, its session and its viewer stay. The person's message is sent as the
   *  claim's next turn (steer, through `reopen`), the holds dropped as it is placed: the turn's end is what this gives. It
   *  gives "lapsed" when a hold can no longer stand before the answer is placed (the cap refused more of the person's time,
   *  or the session went), and the run parks on its question. Undefined when no host holds anything: the run parks. */
  async function waitInClaim(on: Harness, callId: string): Promise<{ next: Promise<TurnEnd | "lapsed"> } | undefined> {
    const holders = specNow?.lifecycle?.personWait ?? [];
    if (!holders.length || !session || !gate || gate.sealed || !root) return undefined;
    await options.beforePersonWait?.();
    // Set before anything else: an answer sent from here is the claim's next turn, never a steer into no turn.
    const [theSession, theGate, conversation] = [session, gate, root];
    const mine: { sent?: Promise<void>; placed?: () => void } = {};
    let placing: Promise<void> = new Promise<void>((resolve) => (mine.placed = resolve));
    reopen = mine;
    waitTurn = mine;
    // The wait as the journal has it: an earlier claim's (its start, so its bound never restarts), or none.
    const entries = await entriesOf(theGate.journal, conversation.id, context);
    const marked = findData<{ callId?: unknown; inClaim?: unknown; at?: unknown }>(entries, KINDS.personAsked, (data) => data.callId === callId && data.inClaim === true && typeof data.at === "number");
    const answeredMark = findData<{ callId?: unknown; answered?: unknown }>(entries, KINDS.personAsked, (data) => data.callId === callId && data.answered === true);
    const showing = marked !== undefined && answeredMark === undefined;
    // The answer already came, between the question's turn end and here, placed as a steer of the idle session (steer):
    // its turn is the next, at once; the row's waiting summary goes.
    const early = idleSteer;
    idleSteer = undefined;
    if (early && (await early.placed)) {
      endWait(mine);
      if (showing) await notWaiting(on, theGate, conversation, callId);
      return { next: turnOfRequest(on, conversation, early.requestId) };
    }
    const since = marked ? (marked.at as number) : now();
    for (const holder of holders) {
      const hold = await Promise.resolve().then(() => holder(on, callId, since)).catch((error: unknown) => {
        console.warn(`[runner] a tool host's person-wait failed: ${said(error)}`);
        return undefined;
      });
      if (hold) waitHolds.push(hold);
    }
    // Nothing held, and no answer placed meanwhile: the run parks.
    if (!waitHolds.length && !mine.sent) {
      endWait(mine);
      return undefined;
    }
    // The wait's start, once, in the journal, with the row's waiting summary (the server tells run.needs_input by it).
    if (!marked && !mine.sent) {
      const shown = theGate.expect(writesEntry(KINDS.personAsked, (data) => data.callId === callId && data.inClaim === true), { run: { summary: ASK_PERSON_WAITING } });
      shown.catch(() => undefined);
      await on.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.personAsked, data: { callId, inClaim: true, at: since } }), context);
      await shown;
    }
    const next = new Promise<TurnEnd | "lapsed">((resolve, reject) => {
      let done = false;
      let lapsed = false;
      const finish = (value: Promise<TurnEnd> | "lapsed") => {
        if (done) return;
        done = true;
        endWait(mine);
        resolve(value);
      };
      // A hold that lapses ends the wait, unless the person's answer is being placed: then the answer's turn stands.
      for (const hold of waitHolds) void hold.lapsed.then(() => {
        lapsed = true;
        if (!mine.sent) finish("lapsed");
      }, () => undefined);
      void (async () => {
        for (;;) {
          await placing;
          try {
            await mine.sent;
            return finish(theSession.turnEnd());
          } catch {
            // Not placed (the steer was refused): the next message may be.
            mine.sent = undefined;
            placing = new Promise<void>((resolve) => (mine.placed = resolve));
            if (lapsed) return finish("lapsed");
          }
        }
      })().catch(reject);
    });
    return { next };
  }

  /** The session and its Harness closed behind the journal's seal: nothing they write after reaches the store. */
  async function closeSession(): Promise<void> {
    gate?.seal(new Interrupted("the Session is closing"));
    endWait();
    const closing = Promise.all([session?.close().catch(() => {}), harness?.close(BACKGROUND_CONTEXT).catch(() => {})]);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([closing, new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_MS)))]);
    clearTimeout(timer);
    session = undefined;
    // The pass's MCP credentials go with it.
    mcp?.release();
    mcp = undefined;
    // The pass's resources go once nothing more is written through them (AdapterRunSpec.release), once each.
    const release = releaseNow;
    releaseNow = undefined;
    await release?.().catch((error: unknown) => console.warn(`[runner] its run's release failed: ${said(error)}`));
  }

  /** The run's end-of-run step: its spec's (AdapterRunSpec.endOfRun) when it has one, else the loop's deps'. */
  const stepOf = (spec: AdapterRunSpec): EndOfRunTurn | undefined => spec.endOfRun ?? deps.endOfRun;

  /** The end-of-run step (stepOf: the spec's, else LoopDeps.endOfRun), asked once: the rows to stage with the end; `stopped` when a person's stop
   *  came during it; `interrupted` when the claim was lost or the runner is closing (no end is written, and the next claim
   *  asks it again). A step that throws on its own writes the end without rows: the run's end never waits on it. */
  async function endOfRunStep(claim: Claim, spec: AdapterRunSpec, outcome: "completed" | "failed"): Promise<{ kind: "rows"; also: readonly AlsoRow[] } | { kind: "stopped"; commandId: number } | { kind: "interrupted" }> {
    const cut = (): { kind: "stopped"; commandId: number } | { kind: "interrupted" } | undefined => {
      if (stopReason?.kind === "command") return { kind: "stopped", commandId: stopReason.commandId };
      if (stopReason || deps.signal.aborted) return { kind: "interrupted" };
      return undefined;
    };
    const step = stepOf(spec);
    if (!step) return { kind: "rows", also: [] };
    if (!spec.agentId) throw new Error("the run's spec names no agent, so its end-of-run step cannot be asked");
    try {
      const rows = await step({ runId: claim.runId, agentId: spec.agentId, claim, outcome, signal: deps.signal, ask: (prompt, opts) => askEndOfRun(claim, prompt, opts.deadlineMs, opts.again === true) });
      return cut() ?? { kind: "rows", also: rows?.also ?? [] };
    } catch (error) {
      return cut() ?? (console.warn(`[runner] ${claim.runId}: its end-of-run step failed: ${said(error)}`), { kind: "rows", also: [] });
    }
  }

  /** What a run cut before it could look back keeps beside its end (LoopDeps.endOfRun with `cut`, never asking): a
   *  person's stop, before or during the end-of-run turn, or a fault. Bounded (CUT_STEP_MS): a step that reads a stalled
   *  store, or throws, keeps nothing, and the end is never held up by it. */
  async function cutRows(claim: Claim, spec: AdapterRunSpec, cut: "stopped" | "stopped-looking" | "faulted"): Promise<readonly AlsoRow[]> {
    const step = stepOf(spec);
    if (!step || !spec.agentId) return [];
    const refuse = () => Promise.reject(new Error("a cut run's end-of-run step asks nothing"));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), CUT_STEP_MS)));
    try {
      const rows = await Promise.race([step({ runId: claim.runId, agentId: spec.agentId, claim, outcome: "failed", cut, signal: deps.signal, ask: refuse }), late]);
      if (rows === "late") {
        console.warn(`[runner] ${claim.runId}: its end-of-run step gave no answer within ${CUT_STEP_MS / 1000} s; the end is written without it`);
        return [];
      }
      return rows?.also ?? [];
    } catch (error) {
      console.warn(`[runner] ${claim.runId}: its end-of-run step failed: ${said(error)}`);
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
      console.warn(`[runner] its end's patch failed: ${said(error)}`);
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  /** The run parked at its cap: its pending budget as an agentrun.budget entry, in one commit with the run parked in the
   *  cap's words (as the ask park's entry and state), and the loop ends parked: a raise row wakes it. */
  async function parkAtCap(on: Harness, conversation: Conversation, theGate: Gate, data: BudgetData): Promise<LoopEnd> {
    await pauseAtCap(on, conversation, theGate, data);
    await releaseHost(on);
    theGate.seal(new Parked());
    return { state: "parked" };
  }

  /** The run's pause at its cap: its agentrun.budget entry, in one commit with the run parked in the cap's words. */
  async function pauseAtCap(on: Harness, conversation: Conversation, theGate: Gate, data: BudgetData): Promise<void> {
    const parkedAt = theGate.expect(writesEntry(KINDS.budget), { run: { state: "parked", summary: data.words } });
    // A seal while the commit is in flight fails it before it is awaited: handled here, read below.
    parkedAt.catch(() => undefined);
    try {
      await on.commit((tx) => tx.appendEntry(conversation.id, { kind: KINDS.budget, data: data as unknown as JsonValue }), context);
    } catch (error) {
      parkedAt.catch(() => undefined);
      throw error;
    }
    await parkedAt;
  }

  /** Waits, at most CLOSE_MS, until every paid request the session admitted is booked: a person's stop is booked at what
   *  streamed once the session's proxy sees its upstream end. Past the bound the end is written anyway, and a request left
   *  unbooked reads at its hold and bound, the worst it can have cost. */
  async function bookingsSettled(): Promise<void> {
    if (unbooked === 0) return;
    specNow?.hooks?.awaitingBookings?.();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([new Promise<void>((resolve) => bookedAll.push(resolve)), new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_MS)))]);
    clearTimeout(timer);
  }

  /** The run's timeline says it went on after its runner was lost (RUN_RESUMED, `after: runner_lost`): one root entry,
   *  no run patch. A journal sealed meanwhile (the claim lost again, a shutdown) refuses it, and the loop goes on as it
   *  would: the next claim says it. */
  async function noteTakenOver(on: Harness, conversation: Conversation, runner: string): Promise<void> {
    try {
      await on.commit((tx) => tx.appendEntry(conversation.id, { kind: RUN_RESUMED, data: { after: "runner_lost", runner, at: Date.now() } }), context);
    } catch (error) {
      if (!gate?.sealed) throw error;
    }
  }

  /** The end commit: an `agentrun.end` entry carrying the run row's final patch (the spec's end patch in it), the rows
   *  staged with it (the end-of-run step's), and the rows it takes. */
  /** `failedWith`: a CLI turn's own error (record "loop"), cut of every secret the runner holds: written in the end's
   *  commit, right before the end, as pi's own error answer (cliErrorAnswer), main's error row for a CLI's turn. */
  async function writeEnd(on: Harness, conversation: Conversation, theGate: Gate, base: EndData, take: readonly number[], also: readonly AlsoRow[] = [], failedWith?: string): Promise<LoopEnd> {
    // The end is the run's release: nothing of this claim lands after it, so the tool host is let go first (its writes in
    // their own commits, the end's patch reading the cost they book), and its requests' bookings come first.
    await releaseHost(on);
    await bookingsSettled();
    const patch = await endPatchOf(base);
    const data: EndData = { ...base, ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}), ...(patch.costUsd !== undefined ? { costUsd: patch.costUsd } : {}), ...(patch.metrics !== undefined ? { metrics: patch.metrics } : {}) };
    const run = {
      state: data.state,
      // An end's summary is its own: with none, a wait's summary the row still says (a question's, a hand-over's: HELD_WAITS
      // and the park's) goes, so an ended run never reads as waiting on its person.
      ...(data.summary ? { summary: data.summary } : {}),
      ...(!data.summary ? { summary: null } : {}),
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
        if (failedWith !== undefined) await tx.appendEntry(conversation.id, { kind: PI_ASSISTANT, model: [cliErrorAnswer(specNow?.adapter.id ?? "cli", failedWith, now())] as never });
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
      // A command row resumes a loop that may have sat past a token's life: its MCP credentials are made fresh again
      // before its next model request.
      if (command.kind === "steer" || command.kind === "approve" || command.kind === "deny" || command.kind === "raise") mcpStale = true;
      if (command.kind === "steer") return steer(command);
      if (command.kind === "approve" || command.kind === "deny") {
        // An answer names its approval: the asked call's id. One that names no call waiting for its answer (an old
        // approval, another run's) is refused, never applied to the call that waits now.
        const approval = approvalOf(command);
        const waits = await waitsFor(approval);
        if (waits === "later") return { later: "the run is parking or ending: the answer waits for its next claim" };
        if (!waits) {
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
      if (isComputerCommand(command)) return computerCommand(command);
      // A pause is a workflow run's: an agentic run's turn is stopped instead, in main's words (runs.ts pause).
      if (command.kind === "pause" || command.kind === "resume") return { refused: AGENTIC_PAUSE_REFUSED };
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
