// A runner: one long-lived process that carries many loops (design: "Runners carry many loops and hold the whole
// kernel"). It polls the store for claimable runs (and claims a run queued in this process at once, on the store's wake)
// and claims up to `loops` of them, renews its claims on one timer,
// hands each run's command rows to its loop, and at a run's end flushes and then releases the claim.
//
// Two guards keep a runner that lost a claim from writing (Solid Queue's rule, then the store's fence):
// - a claim that cannot be renewed before it runs out (less a margin) is lost here: the loop is told to stop, its
//   signal aborted, and the journal handed to it refuses every later commit (ClaimLost) before it reaches the store;
// - the store refuses any write under an epoch another claim moved past (Fenced): the backstop for a runner that froze.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, StorageWrite } from "@earendil-works/pi-durable";
import { COMMAND_KINDS, type CommandSink, endedReason, sendCommand } from "./commands.js";
import { COMPUTER_CALL } from "../computer-channel.js";
import { COMPUTER_HAND_BACK, COMPUTER_TAKE_OVER } from "../computer-commands.js";
import { HELD_COMMANDS } from "../computer-held.js";
import { HAND_BACK } from "./hand-back.js";
import { KINDS, withdrawnAnswers } from "./journal-kinds.js";
import { journalEntries } from "./journal-reader.js";
import { cliModelWorked, type EndCost, endCostOf, runCostOf } from "./metrics.js";
import { inLogOrder, isCliRecord } from "../store-reads/journal.js";
import { bookCutRequests } from "./book-cut.js";
import { type BoundTimer, REAL_TIMER } from "./loop.js";
import { type Claim, ClaimRefused, type Command, type Journal, type Loop, type LoopEnd, type LoopFactory, RELEASE_MARGIN_MS, recoveriesDone, releaseBoundMs, stopEnd, type StopReason } from "./loop-contract.js";
import { FrameTooLarge } from "./run-channel.js";
import { isFenced, type RunnerStore } from "./store-port.js";
import { FINAL_STATES, RunFinal, type RunPatch, type RunState } from "../store/store.js";
import { Unanswered } from "../store/postgres/connection.js";
import { clearWaitEnded } from "../browser-wait-ended.js";
import { clearBrowserHeld } from "../browser-hold.js";
import { keptBy, readKept } from "../workspace/computer-kept.js";
import { cutDeep, heldRedactor, processSecretRedactor, type Redact } from "./redact.js";
import { type LiveTickerOptions, withLiveTicker } from "./live-ticker.js";
import { keepPresence, type Presence } from "./presence.js";
import { flushTraces, genAiTracing } from "../otel/tracer.js";

/** Tries of the re-read after a claim or release commit was answered Unanswered (the commit may have landed). */
const UNKNOWN_READS = 5;
/** Passes of the sweep after a claim answered Unanswered: the commit may still be on its way when the first read comes back
 *  empty, so the read is repeated, waiting twice as long each time, before the lease is left to settle it. */
const UNKNOWN_SWEEPS = 4;
/** The longest wait one timer takes (a 32-bit signed count of ms): a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Most runs a runner holds at once, unless told (RunnerOptions.loops). */
/** A final run's status as its end line says it: the store holds a cancel as state 'stopped' with outcome 'cancelled', so
 *  the outcome tells a cancel from a person's resumable stop. */
export const endedStatus = (run: { state: RunState; outcome?: string | null }): RunState | "cancelled" => (run.state === "stopped" && run.outcome === "cancelled" ? "cancelled" : run.state);

export const RUNNER_LOOPS = 300;
/** How long a claim lasts unless renewed, unless told (RunnerOptions.leaseMs). */
export const RUNNER_LEASE_MS = 30_000;
/** A claim not renewed by its until less this is lost here, unless told (RunnerOptions.stopMarginMs). */
export const RUNNER_STOP_MARGIN_MS = 5_000;
/** When close()'s stop of the loops ends (ms since the epoch), from when the close began (`closedAt`) and when the stop
 *  after the drain began (`stopFrom`): the lease less its margin after the stop's start, or, when later, a computer
 *  provider's cleanup bound and the release's margin from the close's start (releaseBoundMs of `cleanupMs` and
 *  `releaseMarginMs`, default RELEASE_MARGIN_MS: a recovery under way when the close began, or a tool host's release,
 *  ends inside it) and, for the loops' release to be cut and what it books written, the stop's margin or the release's
 *  margin (the cut's booking), whichever is longer (runnerReserveMs). Claims are renewed until then. */
export const runnerStopBy = (closedAt: number, stopFrom: number, leaseMs: number, stopMarginMs: number, cleanupMs?: number, releaseMarginMs?: number): number => Math.max(stopFrom + leaseMs - stopMarginMs, closedAt + releaseBoundMs(cleanupMs, releaseMarginMs) + runnerReserveMs(stopMarginMs, releaseMarginMs));
/** What the end of close()'s window keeps after its loops' release is cut (Runner.close's releaseBy): the stop's margin
 *  or the release's margin (default RELEASE_MARGIN_MS, what the cut's booking may take), whichever is longer, so the
 *  cut's booking and record land while the claims are still renewed. */
export const runnerReserveMs = (stopMarginMs: number, releaseMarginMs: number = RELEASE_MARGIN_MS): number => Math.max(stopMarginMs, releaseMarginMs);
/** The longest close() takes with the default lease and cleanup bound (Runner.close, runnerStopBy): its drain and the
 *  lease less its margin, or the providers' cleanup bound and its margins, whichever is longer (40 s with the default
 *  6 s drain). A claim in flight at the close is waited for inside them, never in a window of its own. A stop deadline that cuts the process sooner cuts a run's end or release short, and the run waits out its
 *  lease before another runner resumes it. */
export const runnerCloseBoundMs = (drainMs: number): number => runnerStopBy(0, drainMs, RUNNER_LEASE_MS, RUNNER_STOP_MARGIN_MS);
/** How long into its close a runner goes on serving what its caller stops when told (Runner.close's loopsStopping: a
 *  ChatGPT renewal), unless its drain ends first: the least stop grace a shipped target gives (Render's fixed 30 s), less
 *  the 25 s a renewal sent then may take to save its pair (chatgpt-plan.ts RENEWAL_DRAIN_MS), less 1 s. */
export const RUNNER_RENEWALS_SERVED_MS = 4_000;
/** From a runner's close until what it tells at loopsStopping is over, with the default lease, whatever its drain: the
 *  tell comes RUNNER_RENEWALS_SERVED_MS in at the latest, with a whole window from then (the lease less its margin, 25 s).
 *  Every shipped stop grace holds it (runner-beside-flags.test.mjs scans them). */
export const RUNNER_RENEWAL_BOUND_MS = RUNNER_RENEWALS_SERVED_MS + RUNNER_LEASE_MS - RUNNER_STOP_MARGIN_MS;

/** How often a runner renews the claims it holds, unless told (RunnerOptions.renewEveryMs). */
export const RUNNER_RENEW_EVERY_MS = 10_000;
/** How often a free runner asks the store for claimable runs, unless told (RunnerOptions.pollMs). */
export const RUNNER_POLL_MS = 1_000;
/** The wait after a parked run's resume first fails, each later one twice the one before, unless told
 *  (RunnerOptions.resumeBackoffMs). */
export const RESUME_BACKOFF_MS = 5_000;
/** The wait before a run whose loop ended interrupted on its own is claimable again, doubling for each such end in a
 *  row, unless told (RunnerOptions.interruptBackoffMs). */
export const INTERRUPT_BACKOFF_MS = 1_000;
/** A runner's name when none is given: its host, its process and a part of a random id. */
export const runnerName = (): string => `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** A failed end's code when the claim was refused for good before any loop started (loop-contract's ClaimRefused). */
const CLAIM_REFUSED = "claim-refused";
/** A failed end's code when the run's records no longer cross the channel to its process (run-channel's FrameTooLarge):
 *  every try reads the same records, so none can go on. */
const TOO_LARGE = "frame-too-large";

/** The untaken row a run ends on when no loop can: a cancel before a stop (it ends the run for good, in its words). */
const endingRow = (untaken: readonly Command[]): Command | undefined => untaken.find((row) => row.kind === "cancel") ?? untaken.find((row) => row.kind === "stop");

/** A commit by a loop whose claim this runner gave up: refused before it reaches the store. */
export class ClaimLost extends Error {
  override name = "ClaimLost";
}

/** A stopped end that may withdraw a call, which the journal would not take or could not be read for: not written. */
class EndNotWithdrawn extends Error {
  override name = "EndNotWithdrawn";
  constructor(runId: string, cause: unknown) {
    super(`run ${runId}: its stopped end was not written with its withdrawal`, { cause });
  }
}

/** The first wait after a stopped end that withdraws a call is refused; each later one doubles (RunnerOptions). */
export const END_RETRY_BACKOFF_MS = 5_000;
/** The command rows a row that cannot be delivered yet does not hold back (runner.ts deliver), beside a stop and a cancel:
 *  those that act on the run's computer for its owner, so a stop that kept the computer can still let it go. */
const PASSES_A_BLOCKED_ROW: ReadonlySet<string> = new Set([...HELD_COMMANDS, COMPUTER_CALL, HAND_BACK, COMPUTER_TAKE_OVER, COMPUTER_HAND_BACK]);

/** The longest wait between those tries: 5 min. */
export const END_RETRY_CAP_MS = 300_000;
/** The tries at that cap before the run ends stopped on its row alone (about an hour of retries in all; endRefused). */
export const END_RETRY_AT_CAP = 11;
/** The most a run's end waits for its census (RunnerOptions.census): 60 s, for up to CENSUS_BYTES_MAX (64 MiB) read
 *  over the run's Workspace (an Archil disk's included). Past it the end goes on without one. */
export const CENSUS_MS = 60_000;

export interface RunnerOptions {
  store: RunnerStore;
  createLoop: LoopFactory;
  /** The runs' live view (live-ticker.ts): each loop's held state written to the store once a tick, by this runner's one
   *  ticker, until close() has let every loop end. On by default where the store has a live view; its options (the tick),
   *  or false for a test that wraps its loops in a ticker of its own or wants none. */
  live?: false | LiveTickerOptions;
  /** This runner's name in the runs it claims (runs.runner). Default: host, pid and a random part. */
  name?: string;
  /** Its word in the store that it is there (presence.ts), kept by its caller (runner/main.ts, whose relay says where it
   *  answers on the same row, under the same incarnation): used as is, never closed here. Default: one of its own,
   *  removed at its close. */
  presence?: Presence;
  /** The incarnation its own presence says (no `presence` given): the runner beside a server runs under the one the
   *  server gave it (Serve.beside), which its paired computers' routes name. Default: a new one. */
  incarnation?: string;
  /** Most runs held at once. */
  loops?: number;
  /** How long a claim lasts unless renewed. */
  leaseMs?: number;
  renewEveryMs?: number;
  /** A claim not renewed by its until less this margin is lost here, and its loop stopped. */
  stopMarginMs?: number;
  /** How often the store is asked for claimable runs while a loop is free. */
  pollMs?: number;
  /** How often each held run's command rows are read: a command reaches its loop within one of these. */
  commandPollMs?: number;
  /** How many times a parked run brought back by a row is tried when its loop cannot start, before that row is refused. */
  resumeTries?: number;
  /** The wait after a resume's first failed try; each later one waits twice the one before. */
  resumeBackoffMs?: number;
  /** The wait before a run whose loop ended interrupted on its own (no stop asked of it: its Session closed itself) is
   *  claimable again; each such end of the run in a row waits twice the one before, up to 64 times this. */
  interruptBackoffMs?: number;
  /** After a claim or release commit answered Unanswered (it may have landed), the wait before the first re-read of what
   *  this runner holds; each retry of that re-read waits twice the one before, up to UNKNOWN_READS tries, then the lease
   *  settles it. */
  unknownBackoffMs?: number;
  /** How long a run's end waits for a command still with its loop before it writes its end; an answer after that is
   *  dropped (nothing written, nothing said). */
  endWaitMs?: number;
  /** How long close() lets each held run go on to its own end (a turn in flight finishes, its outcome journaled, as a
   *  run's own process drained on the server's stop) before it stops the rest for a shutdown, to resume. Its commands
   *  still reach it meanwhile (a person's stop ends it at once). Default 0: every loop stopped at once. */
  drainMs?: number;
  /** A computer provider's own cleanup bound (its cleanupMs; default the providers' RECOVER_MS): each loop waits that and
   *  a margin for its tool hosts to let its run go (releaseBoundMs), and close() gives the loops' stop that long. */
  cleanupMs?: number;
  /** That margin (default RELEASE_MARGIN_MS): what a claim's tool hosts get beyond the cleanup bound to let the run go,
   *  what a release's cut gets to book what it could not let go (LoopDeps.releaseMarginMs), and what close() gives a lost
   *  create's recovery under way to book its release (recoveriesDone). close() keeps it at its window's end, after the
   *  loops' release is cut, when it is longer than the stop's margin (runnerReserveMs). A finite number, 0 or more. */
  releaseMarginMs?: number;
  /** Claiming by memory as well as by count: a waiting run is claimed only while the runs this runner holds and it weigh
   *  no more than `budgetMib` together (each run's weight, `weigh`'s, is what a run of its harness reserves:
   *  runner/memory-claim.ts). Waiting runs are taken oldest first, and one that does not fit stops the claim there, so the
   *  runs behind it wait too and a heavy run is never passed over for ever by light ones. A run heavier than the whole
   *  budget is claimed when the runner holds nothing, so it never waits for ever. Absent: by count alone (`loops`). */
  memory?: RunnerMemory;
  /** The census a run's end writes in the place of the secrets its caller handed it, which that end erases
   *  (run-census.ts; RunPatch.census): made just before each final patch this runner writes, while the run's launch
   *  still holds them, and undefined for a run that holds none. One not made within censusMs, or that fails, is left
   *  out, said as an error event (step "census", the run's id and why): the end then writes the marker "unscanned", and
   *  the run's files are withheld from a cut read after it. Absent: no census (every such end writes the marker). */
  census?: (runId: string) => Promise<RunPatch["census"] | undefined>;
  /** The most a run's end waits for its census. Default CENSUS_MS. */
  censusMs?: number;
  /** A refused stopped end that withdraws a call (endRefused): the first wait, its cap, and the tries at the cap before
   *  the run ends on its row alone. Defaults END_RETRY_BACKOFF_MS, END_RETRY_CAP_MS, END_RETRY_AT_CAP. */
  endRetryBackoffMs?: number;
  endRetryCapMs?: number;
  endRetryAtCap?: number;
  onEvent?: (event: RunnerEvent) => void;
  /** Called once a run this runner ended is final, before its end is said (the "ended" event), with the claim that ended
   *  it: what the run's earlier claims left is let go (workspace/run-end-computers.ts, their computers). A throw is said
   *  as an error; the run's end stands. Absent: nothing. */
  runEnded?: (claim: Claim) => Promise<void>;
  /** The runner's clock (epoch ms) for what it writes itself: a withdrawn answer's time in an end it writes, and every
   *  backoff it releases a run with (the store reads them on its own clock, the same one). Default Date.now. */
  now?: () => number;
  /** The one redactor (redact.ts secretRedactor over the secrets the runner holds): every error text this runner writes
   *  to a run's row or end, or emits, passes through it, and each loop gets it (LoopDeps.redact). Default: the one over every secret this process's environment holds (runnerSecrets), so a runner
   *  started with none (runner/main.ts) still cuts the keys it was started with. */
  redact?: Redact;
  /** Called at each poll for runs (every pollMs, whether or not it holds any) and each renewal pass: the runner's own
   *  loop is turning. The runner process writes its heartbeat from it (runner/main.ts), so a check sees a runner that is
   *  idle and well, and not one whose loop has stopped. A throw is the caller's. */
  onBeat?: () => void;
  /** Whether this runner may claim now: undefined while it may, else why not, in words a person can act on (runner/main.ts
   *  diskFreeGate: a runner whose data directory is not the server's, while the server keeps runs' folders on its own
   *  disk; a runner given an Archil region whose S3 URL may not be the server's). Asked before each poll's claims (`fresh` false: an answer a few seconds old will do) and again, fresh, once a
   *  poll claimed any, before a loop starts on them: a run claimed as the answer changed is released at once, untouched,
   *  for a runner that can serve it. While it refuses, the runner claims nothing and says why on its presence row, where
   *  the server reads it (presence.ts runnersRefused); a throw is said as an error and that poll claims nothing. Absent:
   *  always. */
  claimGate?: (fresh: boolean) => Promise<string | undefined>;
  /** For tests: the claim deadline's clock (the deadline a claim not renewed in time is lost at, and the time its claimed
   *  until is reckoned from). Default: the real one. Nothing else in the runner reads it. */
  clock?: BoundTimer & { now(): number };
  /** For tests: the clock (epoch ms) a held learning child's deadline is read on (its launch's replay or audit
   *  deadline_at, store.runs.learningDeadlines): one still held at it is cancelled, as a person's cancel is. Default
   *  Date.now. */
  learningClock?: () => number;
}

/** A runner's memory budget and its runs' weights, in MiB (RunnerOptions.memory). `weigh` answers each id it is given; an
 *  id it leaves out weighs nothing. */
export interface RunnerMemory {
  readonly budgetMib: number;
  weigh(runIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

export type RunnerEvent =
  | { type: "claimed"; claim: Claim }
  /** A run's start, once: its first claim (from queued). `agent` and `kind` are ids, never a secret. */
  | { type: "started"; runId: string; agent: string; kind: string }
  /** A run's end, once it is final (ended, stopped, failed): its state and the cost its row holds, exact (null when
   *  unknown or only a bound), and `costAtMostUsd` when what it holds is the most the run can have cost. */
  | { type: "ended"; runId: string; agent: string; status: RunState | "cancelled"; costUsd: number | null; costAtMostUsd?: number }
  | { type: "claim-lost"; runId: string; epoch: number; why: "fenced" | "not-renewed" }
  | { type: "released"; runId: string; epoch: number; end: LoopEnd["state"] }
  /** A release that left the run running for another claim (the store keeps it: hand_backs), after its `released`, and
   *  why (HandBackCause). */
  | { type: "handed-back"; runId: string; epoch: number; cause: HandBackCause }
  /** close()'s drain is over: how long it took (`ms`), how many held runs it began with (`held`) and how many were still
   *  going at its end (`left`: stopped for the shutdown and handed back). Said once per close that held a run, a drain of
   *  0 ms (no --drain-timeout) included. */
  | { type: "drained"; ms: number; held: number; left: number }
  | { type: "refused"; runId: string; commandId: number; reason: string }
  /** The runner stopped claiming (`reason`, its claimGate's words) or claims again (null): said once at each change. */
  | { type: "refusing"; reason: string | null }
  /** A learning child (a check's replay run, an audit's shadow run) held at its deadline: its cancel is written. */
  | { type: "learning-deadline"; runId: string }
  /** A run's end made no census (RunnerOptions.census failed, or none came within censusMs): its end writes "unscanned",
   *  and the run's files are withheld from a cut read after it. `cause`: the error's code or name, or "timeout". Said
   *  beside the error event (step "census"), as its metric line (runner-metrics.ts): a runner whose every end fails it
   *  withholds every run's files. */
  | { type: "census-failed"; runId: string; cause: string }
  | { type: "error"; runId?: string; step: string; message: string };

/** Why a runner handed a run back, still running, for another claim: `drain`, its close stopped the run's loop after the
 *  drain; `interrupted`, the run's loop ended interrupted with the runner not closing (its Session closed itself: its
 *  backoff doubles in a row); `end_retry`, a stopped end refused
 *  (EndNotWithdrawn), tried again after a backoff; `give_back`, a claim nothing here holds, given back at once (an
 *  Unanswered claim that had landed, or one made as the runner closed). A lost claim is no hand-back: it is said as
 *  `claim-lost`, and the store moves the run without the runner. */
export type HandBackCause = "drain" | "interrupted" | "end_retry" | "give_back";

export interface Runner {
  readonly name: string;
  /** The incarnation of its word in the store (presence.ts: its caller's, else its own), which its loops hand each claim's
   *  computer (LoopDeps.incarnation): a computer a park keeps pinned to this runner names it. Absent with no store
   *  runners, where no word is kept. */
  readonly incarnation?: string;
  /** The claims this runner holds and has not lost. */
  held(): Claim[];
  /** Stops claiming, lets each held run go on to its own end for up to drainMs, then stops every loop left where it can
   *  resume, flushes and releases their runs. `loopsStopping`: told once, RUNNER_RENEWALS_SERVED_MS into the close or
   *  once the drain is over and every loop left has been told to stop, whichever comes first, with the end of a whole
   *  window from then (epoch ms; none told on a close already made): a run that drain lets finish may still need what
   *  its caller stops there (a ChatGPT renewal: stopRenewals), and what the caller waits for from then ends by that end,
   *  inside RUNNER_RENEWAL_BOUND_MS. */
  close(loopsStopping?: (by: number) => void): Promise<void>;
  /** As if the process froze or died: every timer stops, nothing is stopped, flushed or released (a test's crash). */
  kill(): void;
}

interface Held {
  /** The rows handed on past a blocked row (PASSES_A_BLOCKED_ROW), by id: the cursor stays before the blocked row, so a
   *  later delivery reads them again and must not hand them on twice. */
  passed: Set<number>;
  claim: Claim;
  loop: Loop;
  fence: { lost: boolean };
  abort: AbortController;
  /** Rows above this id have not been read for this claim. */
  cursor: number;
  /** A stop is on its way to the loop, or the loop's start() has returned. */
  stopping: boolean;
  /** The first stop asked of the loop: a shutdown's release says the run was drained (run_attempts cut). */
  stoppedFor?: StopReason["kind"];
  /** A hand-back under way (LoopDeps.handBack): its read of the run's untaken stop rows, then its stop. */
  handingBack?: Promise<void>;
  /** start() has returned: the run's end (its sweep, flush and release) is under way. A Fenced answer now is no lost claim. */
  ending: boolean;
  /** The write that ends the run has landed (the loop's own end commit, or the runner's end of it): the claim is spent,
   *  and renewed no more. Until then an ending claim is still renewed, while its end waits (its census, censusMs). */
  landed: boolean;
  /** No more of the claim is written: set once the end stops waiting for an in-flight delivery, before its sweep. */
  sealed: boolean;
  renewing: boolean;
  /** The claim's first delivery has begun (hold): no delivery before it. A reopened run's claim waits for its earlier hold
   *  to settle before its loop starts, while polls and written rows come due: a loop not started yet cannot take a row
   *  (a run process's host answers { later }, which moves the cursor past it for the whole claim; the adapter loop holds a
   *  steer until it opens, so the first delivery, finding one under way, answered at once and deps.delivered resolved with
   *  a reopen's follow-up still on its way: the claim read it unsent, and a grade's words ran as a plain turn). */
  opened: boolean;
  delivering: boolean;
  /** A command was written while a delivery was in flight: one more delivery follows its end. */
  deliverAgain: boolean;
  /** The delivery under way, which the end waits for (up to endWaitMs) before it writes. */
  inFlight?: Promise<void>;
  deadline?: unknown;
  done?: Promise<void>;
  /** What the run weighs against the memory budget (RunnerOptions.memory), in MiB; 0 without one. */
  mib: number;
  /** A learning child's deadline (ms), read from its launch at its claim; undefined for any other run. */
  learningDeadline?: number;
  /** Aborted at that deadline: its loop's request gate sends no model request after it (LoopDeps.pastDeadline). */
  pastDeadline?: AbortController;
  /** The timer that cancels it at that deadline (armLearningDeadline). */
  learningTimer?: NodeJS.Timeout;
  /** Its cancel at that deadline is written (or being written): never twice. */
  overdue?: boolean;
}

/** A claim that only ends its run, with no loop (endRetried): renewed with the held claims until its end lands. */
type EndOnly = { claim: Claim; landed: boolean; renewing: boolean };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The run states a run patch makes final: a commit that lands one is the run's end, and its release. */
const FINAL = new Set<string>(["ended", "stopped", "failed"]);

export function startRunner(options: RunnerOptions): Runner {
  const {
    store,
    createLoop,
    name = runnerName(),
    loops = RUNNER_LOOPS,
    leaseMs = RUNNER_LEASE_MS,
    renewEveryMs = RUNNER_RENEW_EVERY_MS,
    stopMarginMs = RUNNER_STOP_MARGIN_MS,
    pollMs = RUNNER_POLL_MS,
    commandPollMs = 500,
    resumeTries = 3,
    resumeBackoffMs = RESUME_BACKOFF_MS,
    interruptBackoffMs = INTERRUPT_BACKOFF_MS,
    unknownBackoffMs = 200,
    endWaitMs = 5_000,
    drainMs = 0,
    cleanupMs,
    releaseMarginMs = RELEASE_MARGIN_MS,
    memory,
    census,
    censusMs = CENSUS_MS,
    endRetryBackoffMs = END_RETRY_BACKOFF_MS,
    endRetryCapMs = END_RETRY_CAP_MS,
    endRetryAtCap = END_RETRY_AT_CAP,
    onEvent = () => {},
    runEnded,
    redact: given = processSecretRedactor(),
    now = Date.now,
    learningClock = Date.now,
    onBeat = () => {},
    clock = { now: () => Date.now(), ...REAL_TIMER },
  } = options;
  // The one instance every run's loop gets (LoopDeps.redact), able to hold what each claim opens from the store
  // (redact.ts holdClaimed): a stored key is cut wherever a key of the runner's environment is.
  const redact = heldRedactor(given);
  // The process's tracing, made at its runner's start rather than at its first claim: on, it says so then, and where its
  // spans go (otel/tracer.ts); off (no OTLP endpoint), nothing of OpenTelemetry loads and nothing is said.
  void genAiTracing().catch(() => undefined);
  /** The first try whose wait is the cap (endRefused): 7 with the defaults (5 s × 2^6 = 320 s, over the 300 s cap). */
  const endRetryCapFrom = 1 + Math.ceil(Math.log2(endRetryCapMs / endRetryBackoffMs));
  const beat = () => {
    try {
      onBeat();
    } catch {
      // The caller's: a heartbeat it could not write never stops the runner.
    }
  };
  if (!(stopMarginMs < leaseMs && renewEveryMs < leaseMs - stopMarginMs)) {
    throw new RangeError(`a claim of ${leaseMs} ms must be renewed (every ${renewEveryMs} ms) before its stop margin (${stopMarginMs} ms)`);
  }
  if (!(Number.isFinite(releaseMarginMs) && releaseMarginMs >= 0)) {
    throw new RangeError(`a release margin must be a finite number of ms, 0 or more: ${releaseMarginMs}`);
  }
  // The runs' live view: every loop this runner makes reports its run's held state to the one ticker, which writes it
  // once a tick and is closed at the end of close(), after the drain and the loops' stop.
  const { live = {} } = options;
  const ticker = live !== false && store.live ? withLiveTicker({ live: store.live }, createLoop, live) : undefined;
  const loopsOf: LoopFactory = ticker?.createLoop ?? createLoop;
  const emit = (event: RunnerEvent) => {
    try {
      // An error's text is cut of every secret the runner holds before anyone hears it.
      onEvent(event.type === "error" ? { ...event, message: redact(event.message) } : event);
    } catch {
      // A listener's throw is its own.
    }
  };
  /** Each run's start line in flight, so its end line (announceEnd) never comes before it. */
  const startLines = new Map<string, Promise<void>>();
  /** A run's start, said once: only its first claim (from queued) says it, so a claim taken over after a lost one, or a
   *  resume of a parked run, says nothing. Said with the run's agent and its revision's kind, read now. */
  const announceStart = (claim: Claim): Promise<void> => {
    if (claim.from !== "queued" || !store.runs.get || !store.agents) return Promise.resolve();
    const said = (async () => {
      const run = await store.runs.get!(claim.runId);
      if (!run) return;
      const revision = await store.agents!.revision(run.revisionId);
      emit({ type: "started", runId: claim.runId, agent: run.agentId, kind: revision?.kind ?? "unknown" });
    })().catch(() => undefined);
    startLines.set(claim.runId, said);
    // Once said the entry has done its work: a run another runner ends would otherwise leave it here for good.
    void said.then(() => { if (startLines.get(claim.runId) === said) startLines.delete(claim.runId); });
    return said;
  };
  /** A run's end, said once its row is final: read after the run's release, so a stop that only released it (a shutdown,
   *  a lost claim: the run still running) says nothing. What its earlier claims left goes first (runEnded). */
  const announceEnd = async (claim: Claim): Promise<void> => {
    if (!store.runs.get) return;
    try {
      await startLines.get(claim.runId);
      const run = await store.runs.get(claim.runId);
      if (!run || !FINAL_STATES.includes(run.state)) return;
      await runEnded?.(claim).catch((error: unknown) => emit({ type: "error", runId: claim.runId, step: "run end", message: message(error) }));
      emit({ type: "ended", runId: claim.runId, agent: run.agentId, status: endedStatus(run), costUsd: run.costUsd === null || run.costUsd === undefined ? null : Number(run.costUsd.toFixed(6)), ...(typeof run.costAtMostUsd === "number" ? { costAtMostUsd: Number(run.costAtMostUsd.toFixed(6)) } : {}) });
    } catch {
      // A line that could not be read is not said; the run's end stands.
    }
  };
  /** Every run this runner claimed whose loop has not settled, lost ones included (they still take a loop's place). */
  const runs = new Map<string, Held>();
  /** A lost claim's loop that had not settled when its run was claimed again (its place in `runs` taken by the new one):
   *  still counted against `loops` until it settles, so a loop that ignores its stop never lets the runner hold more. */
  const replaced = new Set<Held>();
  /** The refused stopped ends this runner is trying again (endRetried): close() waits for them. */
  const endings = new Set<Promise<void>>();
  /** The claims those ends hold, renewed (renewAll) until each end lands. */
  const endOnly = new Set<EndOnly>();
  /** Each run's ends in a row, on this runner, as interrupted on its own: its next release's backoff doubles with them. */
  const interruptedInARow = new Map<string, number>();
  let closed = false;
  /** close() is letting its held runs go on to their own ends (drainMs): nothing is claimed, commands still reach them. */
  let draining = false;
  let killed = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let commandTimer: NodeJS.Timeout | undefined;
  /** Stops listening for written commands (store.watchCommands); set once the runner has started. */
  let unwatchCommands: (() => void) | undefined;
  let polling = false;

  /** Run `runId`'s census for its end (RunnerOptions.census), as a patch's part: none past censusMs, or when it fails.
   *  Either is said as an error event (step "census") with the run's id and why, so a 403 on the run's files after its
   *  end can be traced, and as a census-failed event, which a log-based alert counts: an error's code or name only,
   *  never its message, which may name a file of the run's. */
  const censusFor = async (runId: string): Promise<Pick<RunPatch, "census">> => {
    if (!census) return {};
    let stop = () => {};
    let why: string | undefined;
    let cause = "timeout";
    const late = new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => {
        why = `none within ${censusMs} ms`;
        resolve(undefined);
      }, censusMs);
      stop = () => clearTimeout(timer);
    });
    const failed = (error: unknown): undefined => {
      const code = (error as { code?: unknown } | null)?.code;
      cause = typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
      why = `it failed (${cause})`;
      return undefined;
    };
    const made = await Promise.race([census(runId).catch(failed), late]).finally(() => stop());
    if (!made && why !== undefined) {
      emit({ type: "error", runId, step: "census", message: `${why}: the end writes "unscanned", and the run's files are withheld from a cut read after it` });
      emit({ type: "census-failed", runId, cause });
    }
    return made ? { census: made } : {};
  };

  /** The run's journal with this runner's fence on its one write: after the claim is lost, commit throws ClaimLost. A
   *  commit that lands a final run patch (the loop's own end, which is the run's release) calls `ended` at once: from
   *  then the run is ending, before the loop's teardown, so a renew answered Fenced by that end's epoch is never a lost
   *  claim. The patch lands exactly when the batch that writes its effect (the record it is staged with) is stored
   *  (RunStorage.commit): a group commit stores its batches in order up to the first it refuses, so the end's batch can
   *  land while a later sibling is refused, and an end whose own batch is refused has not landed. What it writes and
   *  stages is cut of the run's own tool keys (redact.ts carry), its names too: they are erased at its turn's end, so no
   *  read could. */
  const fenced = (journal: Journal, fence: { lost: boolean }, runId: string, ended: () => void): Journal => {
    /** The effect of the final patch staged and not yet landed, as the store keeps it until a commit stores it. */
    let finalEffect: number | undefined;
    /** That final patch's stage as given to the store, and its census, begun when it was staged: the commit that writes
     *  its effect stages it again with the census, so the end's commit writes it (refuseLeftovers). */
    let finalStaged: { readonly staged: { run?: Record<string, unknown> } & Record<string, unknown>; readonly census: Promise<Pick<RunPatch, "census">> } | undefined;
    /** The commit that carries the final patch, while it waits for its census: a commit asked after it waits for it, so
     *  the run's commits land in the order they were asked. */
    let ending: Promise<unknown> | undefined;
    const carriedOut = <T>(given: T): T => {
      const carried = redact.carried(runId);
      return carried ? cutDeep(given, carried, true) : given;
    };
    return new Proxy(journal, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "stage") {
          return (staged: { run?: { state?: string }; also?: unknown; effect?: unknown } | undefined, ...rest: unknown[]) => {
            const given = carriedOut(staged);
            const result = value.call(target, given, ...rest);
            // As the store keeps it: a run patch or rows staged again replace the one staged before.
            if (staged?.run !== undefined || staged?.also !== undefined) {
              finalEffect = FINAL.has(staged.run?.state ?? "") ? Number(staged.effect) : undefined;
              finalStaged = finalEffect !== undefined && given ? { staged: given as never, census: censusFor(runId) } : undefined;
            }
            return result;
          };
        }
        if (property !== "commit") return value.bind(target);
        // pi's commit is async and pi chains on it (group commit, the publish queue): the refusal is a rejected promise,
        // so it fails that commit on the path pi already handles, never a throw out of a caller that is not async.
        return (...args: unknown[]) => {
          if (fence.lost) return Promise.reject(new ClaimLost(`run ${runId}: this runner lost its claim; the commit is not written`));
          const effect = finalEffect;
          const batches = (Array.isArray(args[0]) ? args[0] : [args[0]]) as unknown[];
          const at = effect === undefined ? -1 : batches.findIndex((batch) => (Array.isArray(batch) ? batch : [batch]).some((write) => Number((write as { value?: { id?: unknown } } | undefined)?.value?.id) === effect));
          const before = ending;
          const carrying = at >= 0 ? finalStaged : undefined;
          const applied = (async () => {
            await before?.catch(() => undefined);
            if (carrying) {
              const { census: made } = await carrying.census;
              // Staged again only while it is still the final patch staged, with its census beside it.
              if (made && finalStaged === carrying) (Reflect.get(target, "stage", target) as (staged: unknown) => void).call(target, { ...carrying.staged, run: { ...carrying.staged.run, census: made } });
            }
            if (fence.lost) throw new ClaimLost(`run ${runId}: this runner lost its claim; the commit is not written`);
            return (await value.apply(target, [carriedOut(args[0]), ...args.slice(1)])) as { stored?: number };
          })();
          if (carrying || before) ending = applied;
          return applied.then((result) => {
            if (at >= 0 && at < (result?.stored ?? 0) && finalEffect === effect) {
              finalEffect = undefined;
              ended();
            }
            return result;
          });
        };
      },
    });
  };

  /** When a claim answered now (a claim's, or a renew's, asked at `sentAt`) is lost unless renewed, on `clock`: its
   *  lease less the stop margin. On a store whose lease clock is this process's own (Store.leaseClock: SQLite) that is
   *  the claim's `until`, read on that clock now, less the margin: the store granted the lease from when the call held
   *  the writer lock, so a call that waited in line for it (another write holding the lock, this runner's own calls
   *  before it on a loaded disk) keeps what it was granted. Otherwise (Postgres: the database's clock) it is reckoned
   *  from when the call was asked, which is never later than its lock. Either way it falls the margin before the
   *  store's lease runs out, and another runner may claim the run. */
  const deadlineOf = (claim: Claim, sentAt: number): number => {
    const leaseNow = store.leaseClock?.();
    return leaseNow === undefined ? sentAt + leaseMs - stopMarginMs : clock.now() + (claim.until - leaseNow) - stopMarginMs;
  };

  const armDeadline = (held: Held, at: number) => {
    clock.clearTimeout(held.deadline);
    held.deadline = clock.setTimeout(() => loseClaim(held, "not-renewed"), Math.max(0, at - clock.now()));
  };

  /** The claim is gone (fenced) or about to run out unrenewed: write nothing more, and stop the loop. */
  const loseClaim = (held: Held, why: "fenced" | "not-renewed") => {
    // A run that is ending gave its claim up itself (or is about to): a Fenced answer to a call that was in flight then
    // is no lost claim, and its loop has already stopped.
    if (held.fence.lost || held.ending || killed) return;
    held.fence.lost = true;
    clock.clearTimeout(held.deadline);
    emit({ type: "claim-lost", runId: held.claim.runId, epoch: held.claim.epoch, why });
    // Its attempt was cut by the lapse, said while this runner is still there (run_attempts); a store it cannot reach
    // leaves it unsaid, and the claim that takes the run over reads a crash.
    store.runAttempts?.lapsed(held.claim.runId, held.claim.epoch).catch(() => undefined);
    stopLoop(held, { kind: "claim-lost" });
    held.abort.abort(new ClaimLost(`run ${held.claim.runId}: claim lost (${why})`));
  };

  const stopLoop = (held: Held, reason: StopReason) => {
    // A person's stop of a run that keeps its computer for its owner ends its agent only: its rows (the owner's calls,
    // the release, a cancel) are still handed on until the computer is let go.
    if (!held.loop.keepsComputer?.(reason)) held.stopping = true;
    held.stoppedFor ??= reason.kind;
    held.loop.stop(reason).catch((error: unknown) => emit({ type: "error", runId: held.claim.runId, step: "stop", message: message(error) }));
  };

  /** Every held claim renewed in one transaction (store.renewMany), never one per run: a claim answered Fenced is lost,
   *  the others move on. Any other failure (a busy store) is tried at the next renew; each run's deadline stops its loop
   *  if none lands. An ending claim is renewed too, until the write that ends its run lands (Held.landed): its end waits
   *  for the run's census (up to censusMs, longer than a lease), and a claim that ran out meanwhile would have that write
   *  refused (Fenced), the run left unfinished and claimed again. Its renew's answer is not read: an ending claim is never
   *  lost (loseClaim) and has no deadline. So are the claims that only end a run (endRetried), until theirs lands. Once an
   *  end lands its claim is spent: no renew races the release that follows. */
  const renewAll = async () => {
    if (killed) return;
    beat();
    const due = [...runs.values()].filter((held) => !held.renewing && !held.fence.lost && !held.landed);
    const ends = [...endOnly].filter((only) => !only.renewing && !only.landed);
    if (due.length === 0 && ends.length === 0) return;
    for (const one of [...due, ...ends]) one.renewing = true;
    const sentAt = clock.now();
    try {
      const results = await store.renewMany([...due, ...ends].map((one) => one.claim), { leaseMs });
      results.slice(0, due.length).forEach((result, i) => {
        const held = due[i]!;
        if (held.fence.lost || held.ending || killed) return;
        if (isFenced(result)) loseClaim(held, "fenced");
        else {
          held.claim = result as Claim;
          armDeadline(held, deadlineOf(held.claim, sentAt));
        }
      });
    } catch (error) {
      for (const one of [...due, ...ends]) emit({ type: "error", runId: one.claim.runId, step: "renew", message: message(error) });
    } finally {
      for (const one of [...due, ...ends]) one.renewing = false;
    }
  };
  const renewTimer = setInterval(() => void renewAll(), renewEveryMs);

  /** Hands the run's new command rows to its loop: stop as stop(), the other kinds as command(); refusals are taken. The
   *  run's end waits for it (finish), so a refusal of a command the loop had when it ended is written before the release;
   *  once the end has sealed the claim, an answer still to come is dropped: nothing written, nothing said. `given`: the
   *  rows the runner's one read of every run found for it (deliverAll), else it reads its own. */
  const deliver = (held: Held, given?: readonly Command[]): Promise<void> => {
    if (!held.opened || held.delivering || held.stopping || held.ending || held.fence.lost || killed) return Promise.resolve();
    held.delivering = true;
    // Declared before it is assigned: its own finally reads it.
    let delivery: Promise<void> | undefined;
    delivery = (async () => {
      try {
        const rows = given ?? (await store.commands(held.claim.runId, held.cursor));
        // A row whose delivery threw (its loop could not take it yet: a message whose model key cannot be read, adapter-
        // loop.ts command) blocks the rows after it, which wait in order behind it, but a stop or a cancel: those still
        // reach the loop, so a run is never kept turning and spending behind a row it cannot take. The cursor stays before
        // the blocked row, which the next poll delivers again; the error is said once the rows are read.
        let blocked: { error: unknown } | undefined;
        for (const row of rows) {
          if (held.stopping || held.ending || held.fence.lost || killed) break;
          // A row another delivery handed on since the runner's read is not handed on again.
          if (row.id <= held.cursor) continue;
          // The cursor moves past a row only once its delivery went through (handed to the loop, and any refusal written):
          // a delivery that throws leaves the row for the next poll, never skipped for the rest of the claim.
          if (row.takenAt !== null) {
            if (!blocked) held.cursor = Math.max(held.cursor, row.id);
            continue;
          }
          // A row handed on past a blocked row earlier (PASSES_A_BLOCKED_ROW) is never handed on again.
          if (held.passed.has(row.id)) {
            if (!blocked) held.cursor = Math.max(held.cursor, row.id);
            continue;
          }
          if (row.kind === "stop" || row.kind === "cancel") {
            if (!blocked) held.cursor = Math.max(held.cursor, row.id);
            stopLoop(held, { kind: "command", commandId: row.id, ...(row.kind === "cancel" ? { cancel: true as const } : {}) });
            // A stop that keeps the run's computer leaves the rows after it to be handed on (the loop head ends the rest).
            continue;
          }
          // Past a blocked row, the commands that act on the run's computer for its owner go on too (a release, a start,
          // a call, a take-over and a hand-back): a stop that kept the computer must still be able to let it go. Each is
          // handed on once (held.passed), the cursor still before the blocked row; the message itself is never handed on.
          if (blocked) {
            if (!PASSES_A_BLOCKED_ROW.has(row.kind) || held.passed.has(row.id)) continue;
            try {
              const passed = await held.loop.command(row);
              // Marked handed on only once its answer is kept: a refusal whose write fails is asked of the loop again at the
              // next delivery, so its caller hears it once the store answers, never a silence.
              if ("refused" in passed) {
                await store.take(held.claim, row.id, "refused", passed.refused);
                emit({ type: "refused", runId: held.claim.runId, commandId: row.id, reason: passed.refused });
              }
              held.passed.add(row.id);
            } catch (error) {
              if (isFenced(error) || held.sealed || killed) throw error;
            }
            continue;
          }
          let outcome: Awaited<ReturnType<typeof held.loop.command>>;
          try {
            outcome = COMMAND_KINDS.has(row.kind) ? await held.loop.command(row) : { refused: `no command is of kind ${JSON.stringify(row.kind)}` };
          } catch (error) {
            if (isFenced(error) || held.sealed || killed) throw error;
            blocked = { error };
            continue;
          }
          if (held.sealed || killed) return;
          // `taken`: the loop's commit took it. `later`: left untaken for the run's next claim. Only a refusal is written here.
          if ("refused" in outcome) {
            await store.take(held.claim, row.id, "refused", outcome.refused);
            emit({ type: "refused", runId: held.claim.runId, commandId: row.id, reason: outcome.refused });
          }
          held.cursor = Math.max(held.cursor, row.id);
        }
        if (blocked) throw blocked.error;
      } catch (error) {
        if (held.sealed || killed) return;
        if (isFenced(error)) loseClaim(held, "fenced");
        else emit({ type: "error", runId: held.claim.runId, step: "commands", message: message(error) });
      } finally {
        held.delivering = false;
        if (held.inFlight === delivery) held.inFlight = undefined;
        // A row written while this delivery ran: read again now (deliver itself checks the run still takes rows).
        if (held.deliverAgain) {
          held.deliverAgain = false;
          if (delivering()) void deliver(held);
        }
      }
    })();
    held.inFlight = delivery;
    return delivery;
  };
  /** One read of every held run's new command rows a tick (store.commandsOf), never one per run, each run's then handed
   *  to its loop; the next tick is set once this read is done. */
  const delivering = () => !killed && (!closed || draining);
  const deliverAll = () => {
    if (!delivering()) return;
    void (async () => {
      const due = [...runs.values()].filter((held) => held.opened && !(held.delivering || held.stopping || held.ending || held.fence.lost));
      if (due.length === 0) return;
      try {
        const rows = await store.commandsOf(due.map((held) => ({ runId: held.claim.runId, after: held.cursor })));
        for (const held of due) void deliver(held, rows.get(held.claim.runId) ?? []);
      } catch (error) {
        for (const held of due) emit({ type: "error", runId: held.claim.runId, step: "commands", message: message(error) });
      }
    })().finally(() => {
      if (delivering()) commandTimer = setTimeout(deliverAll, commandPollMs);
    });
  };

  /** After start() settles: a final run's leftover rows refused, then one flush, then the release. A lost claim writes
   *  nothing; a killed runner does nothing. */
  /**
   * Ends the run under `claim` in its journal, for a loop that could not write its own end: an agentrun.end entry on the
   * run's root conversation (one made for it when the run has none yet), with the run row's patch and the commands in
   * `take` keyed to that entry, so they land in its one commit or not at all. When the journal cannot take that commit,
   * the run row alone (runs.update, the same take in its one transaction), unless the end is a stop that may withdraw a
   * call (one waits, or the journal could not be read to say none does): that end is never written without its withdrawal,
   * so it throws EndNotWithdrawn and the run is left as it stands, not final, its stop untaken (endRefused retries it). A
   * lost claim (Fenced) writes neither. A person's stop written on the row alone keeps no outcome 'stopped': with no end
   * in its journal, a reopen would find no turn to follow (its next claim would read the run as never started), so it
   * reads as a stop that is over (cancelled), as it read before a stop and a cancel were told apart.
   */
  const endRun = async (claim: Claim, given: { state: "stopped" | "failed"; summary: string; outcome?: "stopped" | "cancelled" }, take: readonly number[], withdrawnAs: "withdrawn" | "canceled" = "withdrawn", landed: () => void = () => {}, cost?: EndCost) => {
    // Why the run ended, as its end and its row say it: cut of every secret the runner holds (an error's text may echo one).
    const data = { ...given, summary: redact(given.summary) };
    // Unknown means it may withdraw: false only once the journal was read and no call of it waits.
    let mayWithdraw = data.state === "stopped";
    // A run whose journal holds no conversation never sent a request: its end carries a cost of $0, as a loop's end does.
    let neverSent = false;
    // Where in the run's files what its caller handed it sits, written in its place as this end erases it.
    const counted = await censusFor(claim.runId);
    try {
      const journal = store.journal(claim);
      const [root] = (await journal.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items;
      if (!root) mayWithdraw = false;
      neverSent = !root;
      const writes: StorageWrite[] = [];
      let conversationId = root?.id;
      if (conversationId === undefined) {
        conversationId = (await journal.mintId()) as unknown as ConversationId;
        writes.push({ type: "conversation", value: { id: conversationId } } as StorageWrite);
      }
      // A stopped end withdraws every call still waiting for its answer (an ask with no answer), in this commit: the
      // approval card of a run whose loop could not start reads answered, never waiting for good.
      if (data.state === "stopped" && root) {
        const withdrawn = withdrawnAnswers(await journalEntries(journal, BACKGROUND_CONTEXT), new Date(now()).toISOString(), withdrawnAs);
        mayWithdraw = withdrawn.length > 0;
        for (const answer of withdrawn) {
          const answerId = (await journal.mintId()) as unknown as EntryId;
          writes.push({ type: "entry", value: { id: answerId, conversationId, kind: KINDS.answer, data: answer as unknown as JsonValue } } as StorageWrite);
        }
      }
      const id = (await journal.mintId()) as unknown as EntryId;
      writes.push({ type: "entry", value: { id, conversationId, kind: KINDS.end, data: data as unknown as JsonValue } } as StorageWrite);
      journal.stage({ run: { state: data.state, summary: data.summary, ...(data.outcome ? { outcome: data.outcome } : {}), ...(cost ?? (neverSent ? { costUsd: 0 } : {})), ...counted }, effect: id as unknown as number, ...(take.length ? { take: take.map((command) => ({ command, effect: id as unknown as number })) } : {}) });
      const result = await journal.commit([writes], () => {}, BACKGROUND_CONTEXT);
      if (result.stored !== 1) throw result.refused ?? new Error("the run's end was not stored");
      landed();
    } catch (error) {
      if (isFenced(error)) throw error;
      if (mayWithdraw) throw new EndNotWithdrawn(claim.runId, error);
      await store.runs.update(claim, { state: data.state, summary: data.summary, ...(data.outcome === "cancelled" ? { outcome: data.outcome } : {}), ...cost, ...counted }, take.length ? { take } : undefined);
      landed();
    }
    // An ended run's Screen has no ended-while-waiting state to keep (browser-wait-ended.ts): its row goes with the end.
    if (store.settings) await clearWaitEnded(store.settings, claim.runId, claim.epoch).catch(() => undefined);
    // Nor a take of its browser (browser-hold.ts).
    if (store.settings) await clearBrowserHeld(store.settings, claim.runId, claim.epoch).catch(() => undefined);
  };

  /** Ends the run under `claim` stopped on its untaken `stop` (or cancel) row (endRun). False when that end may withdraw a
   *  call and the journal would not take it or could not be read: the refusal is then the run's (endRefused). */
  const endStopped = async (claim: Claim, stop: Command, landed: () => void, cost?: EndCost): Promise<boolean> => {
    try {
      const end = stopEnd(stop.kind === "cancel");
      await endRun(claim, end, [stop.id], stop.kind === "cancel" ? "canceled" : "withdrawn", landed, cost);
      return true;
    } catch (error) {
      if (!(error instanceof EndNotWithdrawn)) throw error;
      await endRefused(claim, stop, error, landed, cost);
      return false;
    }
  };

  /** A stopped run's end, written (its stop row taken) or written row-only at the give-up: every other untaken row was
   *  refused in that same write, which released the run (the store's rule for a write that makes a run final), said here
   *  from what the end refused. Nothing is taken after it (its claim is spent). */
  const releaseStopped = async (claim: Claim, stop: Command) => {
    const reason = endedReason("stopped");
    for (const row of await store.commands(claim.runId, 0)) {
      if (row.id !== stop.id && row.refused === reason) emit({ type: "refused", runId: claim.runId, commandId: row.id, reason });
    }
    await store.flush();
    await release(claim, {});
    emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: "stopped" });
    await announceEnd(claim);
  };

  /**
   * A stopped end that may withdraw a call, refused (EndNotWithdrawn): counted on its stop row's tries, said by the run's
   * name, and the claim released with the run still running (not final) and a backoff that doubles from
   * endRetryBackoffMs up to endRetryCapMs; the next claim only ends it (claimMore: endRetried), never runs a turn. Once the
   * backoff has sat at its cap for endRetryAtCap tries, the run ends stopped on its row alone, said as an error by name:
   * a journal that never takes the end never keeps a stopped run alive. With the defaults (5 s doubling to a 5 min cap,
   * 11 tries at the cap): 6 growing waits (5 s to 160 s, 315 s in all), then 11 of 5 min, so about an hour (3,615 s) of
   * retries, and the 18th refusal gives up.
   */
  const endRefused = async (claim: Claim, stop: Command, refused: EndNotWithdrawn, landed: () => void, cost?: EndCost) => {
    const tries = await store.retry(claim, stop.id);
    const why = message(refused.cause);
    if (tries >= endRetryCapFrom + endRetryAtCap) {
      emit({ type: "error", runId: claim.runId, step: "end", message: `run ${claim.runId} ended without withdrawing: journal unreadable or refusing (after ${tries} tries; the last: ${why})` });
      // On its row alone, so no outcome 'stopped' (endRun): a run whose journal never took its end is never reopened.
      const end = stopEnd(stop.kind === "cancel");
      await store.runs.update(claim, { state: end.state, summary: redact(end.summary), ...(end.outcome === "cancelled" ? { outcome: end.outcome } : {}), ...cost, ...(await censusFor(claim.runId)) }, { take: [stop.id] });
      landed();
      await releaseStopped(claim, stop);
      return;
    }
    const wait = Math.min(endRetryBackoffMs * 2 ** (tries - 1), endRetryCapMs);
    emit({ type: "error", runId: claim.runId, step: "end", message: `run ${claim.runId}: its end with a withdrawal was refused (try ${tries}); retrying in ${wait} ms: ${why}` });
    await store.flush();
    // Running, said: a stop that reached the loop while it parked (its ask landed with the run parked, under this claim)
    // leaves the row parked, and a release with no state keeps it so; the store's parked rule admits an untaken stop
    // whatever its backoff (a person's stop never waits on a failed resume's), so the run would be claimed again at once.
    // No cut: the next claim only retries the end (endRetried), never the turn, so it redoes no request or paid call, and
    // the work before the stop stays billable (run-usage.ts attemptTags reads a redo only after a cut).
    await release(claim, { state: "running", backoffUntil: now() + wait });
    emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: "interrupted" });
    emit({ type: "handed-back", runId: claim.runId, epoch: claim.epoch, cause: "end_retry" });
  };

  /** Whether the run under `claim` never started: its journal has no conversation yet, so no input of it went out. A
   *  journal that cannot be read says no (the claim's loop applies the stop as it would). */
  const neverStarted = async (claim: Claim): Promise<boolean> => {
    try {
      return (await store.journal(claim).scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items.length === 0;
    } catch {
      return false;
    }
  };

  /** Whether the run under `claim` has a computer its park kept pinned to a runner other than this one, this process
   *  (computer-kept.ts: the row names a runner and incarnation, keptBy). A row that cannot be read says yes: a loop
   *  started on a guess would read the row again in its claim's computer, take it and try the machine from here,
   *  dropping the row that runner's timer ends it by. Ending the stop with no loop touches no computer, and the row's
   *  runner (or any janitor, once that runner is gone) still ends it. */
  const keptElsewhere = async (claim: Claim): Promise<boolean> => {
    if (!store.settings) return false;
    try {
      const kept = await readKept(store.settings, claim.runId);
      return kept?.runner !== undefined && !keptBy(kept, incarnation ? { runner: name, incarnation } : undefined);
    } catch {
      return true;
    }
  };

  /** What the run under `claim` booked in its journal, as an end stores its cost (metrics.ts endCostOf, the rule every end
   *  stores by, over its booking as learning-end.ts reads it): a figure, or a bound when a cut request's hold is counted
   *  in it. A request an earlier claim left out is booked first, cut at its hold, as a loop's booking books it before it
   *  sends anything (book-cut.ts). Undefined when the journal cannot be read: the end then stores no cost, as it did. */
  const bookedOf = async (claim: Claim): Promise<EndCost | undefined> => {
    try {
      await bookCutRequests(store.journal(claim), BACKGROUND_CONTEXT, () => store.flush());
      const entries = inLogOrder(await journalEntries(store.journal(claim), BACKGROUND_CONTEXT));
      return endCostOf(runCostOf(entries, { unbooked: isCliRecord(entries) && cliModelWorked(entries) }));
    } catch {
      return undefined;
    }
  };

  /** A claim of a run whose stopped end was refused (its untaken stop row has tries): it only ends the run, with no loop,
   *  so no turn, model request or tool runs on a run that is stopping. `booked`: a learning child past its deadline, which
   *  an earlier claim's loop may have spent on before its runner went (its spend booked in its journal): its end stores
   *  that booking as its cost (bookedOf), so what it spent stays its run's, never an unknown no read heals. */
  const endRetried = async (claim: Claim, stop: Command, booked = false) => {
    // Renewed with the held claims (renewAll) until its end lands: its end waits for the run's census too.
    const only: EndOnly = { claim, landed: false, renewing: false };
    endOnly.add(only);
    try {
      // A run stopped before any loop started still has its one start line, ahead of its end.
      await announceStart(claim);
      const cost = booked ? await bookedOf(claim) : undefined;
      if (await endStopped(claim, stop, () => (only.landed = true), cost)) await releaseStopped(claim, stop);
    } catch (error) {
      emit({ type: "error", runId: claim.runId, step: isFenced(error) ? "end (fenced)" : "end", message: message(error) });
    } finally {
      endOnly.delete(only);
    }
  };

  const finish = async (held: Held, end: LoopEnd, threw: boolean) => {
    // Whether the runner asked the loop to stop before it ended (only stopLoop sets this).
    const stoppedBefore = held.stopping;
    held.ending = true;
    clock.clearTimeout(held.deadline);
    clearTimeout(held.learningTimer);
    const { claim } = held;
    // The runner's own end of the run, once its write lands: the claim is renewed until then (renewAll), no further.
    const landed = () => {
      held.landed = true;
    };
    // A command still with the loop: its refusal is written before anything of the end, never after the release. A loop
    // that does not answer within endWaitMs has its answer dropped (the claim is sealed first).
    if (held.inFlight) {
      let waited: NodeJS.Timeout | undefined;
      await Promise.race([held.inFlight, new Promise<void>((resolve) => (waited = setTimeout(resolve, endWaitMs)))]);
      clearTimeout(waited);
    }
    held.sealed = true;
    try {
      if (killed) return;
      // A loop that came back with a final end wrote it: its end commit landed, and a write that makes the run final is its
      // release (the store's rule). A renew answered Fenced after that commit is expected, never a lost claim: the end goes
      // on as any end does, made durable (a flush) before the runner says released. Any other lost claim writes nothing.
      const endedItself = !threw && (end.state === "ended" || end.state === "stopped" || end.state === "failed");
      if (held.fence.lost && !endedItself) return;
      // A parked run brought back (a raise, an approval) whose loop threw before it could start stays parked: its waking
      // row keeps one more try, and the run is claimable again after a backoff; after the last try that row is refused
      // with why, and a person can raise again or stop it (#1944-5). A claim its spec refuses (ClaimRefused: a handed
      // sign-in that won't read back, an MCP pin refused) never comes here: the loop writes that end itself, final, the run
      // failed in the refusal's words.
      // A claim refused for good (CLAIM_REFUSED), or a run whose records no longer cross to its process (TOO_LARGE), is no
      // resume to try again: it fails the run below, parked or not, and the row that woke it (an approval already answered
      // 204) is refused as a failed run's, never left to wait.
      if (threw && end.state === "failed" && claim.from === "parked" && end.error.code !== CLAIM_REFUSED && end.error.code !== TOO_LARGE) return await resumeFailed(held, end.error.message);
      if (threw && end.state === "failed") {
        // A loop that failed with no end written: a person's stop waiting now is the run's end (stopped, its row taken),
        // never refused as a failed run's; else the run ends failed with why. Either way its end is in the journal.
        const stop = endingRow((await store.commands(claim.runId, 0)).filter((row) => row.takenAt === null));
        if (stop) {
          if (!(await endStopped(claim, stop, landed))) return;
          end = { state: "stopped" };
        } else {
          await endRun(claim, { state: "failed", summary: end.error.message }, [], "withdrawn", landed);
        }
      }
      if (end.state === "ended" || end.state === "stopped" || end.state === "failed") {
        // The write that made the run final refused its untaken rows itself, in that transaction (the store's rule), and
        // released the run: said here as the runner always said them. Nothing is taken after it (its claim is spent).
        const reason = endedReason(end.state);
        for (const row of await store.commands(claim.runId, 0)) {
          if (row.refused === reason) emit({ type: "refused", runId: claim.runId, commandId: row.id, reason });
        }
        // The run's end (a normal completion among them) leaves no browser-released message behind for a follow-up (browser-wait-ended.ts).
        if (store.settings) await clearWaitEnded(store.settings, claim.runId, claim.epoch).catch(() => undefined);
        if (store.settings) await clearBrowserHeld(store.settings, claim.runId, claim.epoch).catch(() => undefined);
      }
      await store.flush();
      // A loop that ended interrupted with no stop asked of it (its Session closed itself) is released with a backoff that
      // doubles each time in a row, so a Harness that keeps closing is not claimed again every poll. A stopped loop (a
      // shutdown, a lost claim) is released at once, for another runner to take over.
      const closedItself = end.state === "interrupted" && !stoppedBefore;
      const inARow = closedItself ? (interruptedInARow.get(claim.runId) ?? 0) + 1 : 0;
      if (inARow > 0) interruptedInARow.set(claim.runId, inARow);
      else interruptedInARow.delete(claim.runId);
      // A run let go unfinished says why on its claim's attempt (run_attempts cut): a runner's close drained it, or its
      // loop ended interrupted on its own and the run is tried again. The next claim works its turn again.
      const cut = end.state !== "interrupted" ? undefined : closedItself ? "retry" as const : held.stoppedFor === "shutdown" ? "drain" as const : undefined;
      const wakeAt = end.state === "parked" ? parkedWake(held, end.wakeAt) : undefined;
      // A reopen since this end's commit (the run's release) has moved the epoch: this release has nothing left to write.
      await release(claim, {
        // Parked again with nothing written (LoopEnd `again`): the release parks the row, its words left as they stood.
        ...(end.state === "parked" && end.again ? { state: "parked" as const } : {}),
        ...(wakeAt !== undefined ? { wakeAt }
        : inARow > 0 ? { backoffUntil: now() + interruptBackoffMs * 2 ** Math.min(inARow - 1, 6) }
        : {}),
        ...(cut ? { cut } : {}),
      }).catch((error: unknown) => {
        if (!held.landed || !isFenced(error)) throw error;
      });
      emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: end.state });
      // Left running for another claim: a hand-back, by its cause (this runner's close stopped its loop, or it ended so).
      if (end.state === "interrupted") emit({ type: "handed-back", runId: claim.runId, epoch: claim.epoch, cause: closed && !closedItself ? "drain" : "interrupted" });
      if (end.state === "ended" || end.state === "stopped" || end.state === "failed") await announceEnd(claim);
    } catch (error) {
      emit({ type: "error", runId: claim.runId, step: isFenced(error) ? "release (fenced)" : "release", message: message(error) });
    } finally {
      // Only its own entry: a run this runner lost and claimed again holds a new one under the same id. Its own keys go
      // with it: a next claim opens them again.
      if (runs.get(claim.runId) === held) {
        runs.delete(claim.runId);
        redact.dropCarried(claim.runId);
      }
    }
  };

  /** When parked run `held` wakes: its loop's `wakeAt`, or a learning child's deadline when sooner, so a child parked
   *  (for an approval, a raise) is claimed again at its deadline and ends there (claimMore's overdue claim), never left
   *  parked past it holding its copy of its run's key, its run's learning_work running. The learning clock is the store's
   *  but in a test. */
  const parkedWake = (held: Held, wakeAt: number | undefined): number | undefined =>
    held.learningDeadline === undefined ? wakeAt : wakeAt === undefined ? held.learningDeadline : Math.min(wakeAt, held.learningDeadline);

  /** A parked run's resume that threw: one more try on the row that woke it, released parked with a backoff; after
   *  `resumeTries`, that row refused with why and the run released parked with nothing to wake it but a learning child's
   *  deadline (parkedWake). */
  const resumeFailed = async (held: Held, why: string) => {
    const { claim } = held;
    const wake = parkedWake(held, undefined);
    const wakeAt = wake === undefined ? {} : { wakeAt: wake };
    const untaken = (await store.commands(claim.runId, 0)).filter((row) => row.takenAt === null);
    const stop = endingRow(untaken);
    const woke = untaken[0];
    if (stop) {
      // A stop never waits on a loop that cannot start: the run ends stopped here, its stop row taken, and every other
      // untaken row refused as a stopped run's.
      // One write: the run ends stopped with its stop row taken, or neither (a final run never keeps its stop untaken).
      if (await endStopped(claim, stop, () => (held.landed = true))) await releaseStopped(claim, stop);
      return;
    }
    if (woke) {
      const tries = await store.retry(claim, woke.id);
      if (tries >= resumeTries) {
        const reason = `the run could not go on after ${tries} tries; the last: ${why}`;
        await store.take(claim, woke.id, "refused", reason);
        emit({ type: "refused", runId: claim.runId, commandId: woke.id, reason });
        await store.flush();
        await release(claim, { state: "parked", ...wakeAt });
      } else {
        await store.flush();
        await release(claim, { state: "parked", ...wakeAt, backoffUntil: now() + resumeBackoffMs * 2 ** (tries - 1) });
      }
    } else {
      await store.flush();
      await release(claim, { state: "parked", ...wakeAt });
    }
    emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: "parked" });
  };

  /** Holds `claim` and starts its loop. `learningDeadline`: a learning child's deadline, read at its claim
   *  (learningDeadlinesOf), at which its loop sends no model request more and the runner cancels it if still at work
   *  (cancelOverdue). */
  /** Holds `claim` and starts its loop. `after`: an earlier hold of the same run still settling (its end landed and a
   *  message reopened the run, or its claim was lost), whose process may still be cleaning up the run's folders and its
   *  slot: this claim is held and renewed meanwhile, and its loop starts, and its rows are delivered, only once that
   *  hold has settled. */
  const hold = (claim: Claim, sentAt: number, mib = 0, learningDeadline?: number, after?: Promise<void>) => {
    const fence = { lost: false };
    const abort = new AbortController();
    const pastDeadline = learningDeadline === undefined ? undefined : new AbortController();
    let firstDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => (firstDelivered = resolve));
    // Set below, once held is made: the loop's end commit lands only after start(), well after.
    let ending: () => void = () => {};
    // Set below, once held is made: the loop asks deliverNow only once its first turn has ended, well after.
    let heldNow: Held | undefined;
    // This runner's process as its word in the store names it (presence.ts), for the claim's computer: a park that keeps one
    // only this runner can reach again pins it to this runner and this incarnation (computer-kept.ts pinnedOf).
    const loop = loopsOf({
      ...(incarnation ? { incarnation } : {}),
      journal: (forClaim) => fenced(store.journal(forClaim), fence, forClaim.runId, () => ending()),
      flush: () => store.flush(),
      signal: abort.signal,
      ...(pastDeadline ? { pastDeadline: pastDeadline.signal } : {}),
      delivered,
      // A delivery under way first (its rows are the loop's already), then one more read of the run's new rows.
      deliverNow: async () => {
        if (!heldNow) return;
        await heldNow.inFlight?.catch(() => undefined);
        await deliver(heldNow);
      },
      // A row the loop took for now and refused later (the dispatch's replay): written refused under the claim held now (its
      // last renew's), as deliver writes a refusal the loop answered at once. As there, nothing is written once the end
      // sealed the claim, and a fenced write loses the claim.
      refuse: async (commandId, reason) => {
        const held = heldNow;
        if (!held || held.sealed || killed) return;
        try {
          await store.take(held.claim, commandId, "refused", reason);
        } catch (error) {
          if (held.sealed || killed) return;
          if (isFenced(error)) return void loseClaim(held, "fenced");
          throw error;
        }
        emit({ type: "refused", runId: held.claim.runId, commandId, reason });
      },
      redact,
      releaseBoundMs: releaseBoundMs(cleanupMs, releaseMarginMs),
      releaseMarginMs,
      releaseBy: () => releaseBy,
      // Only in a close, and once (every reader that asks meanwhile waits on the one answer): a stop or cancel a person
      // sent that no delivery has handed on yet is the run's end, read as the close reads it (closingEnds), since a loop
      // stopping is handed no more rows and the close reads none for it. Else, or past it (a stop that keeps the run's
      // computer), the loop is stopped for a shutdown and its signal aborted, as at the drain's end, so the run is handed
      // back (cut "drain") and its turn resumes on the next claim.
      handBack: () => {
        const now = heldNow;
        if (!closed || !now || now.ending || now.stopping || now.fence.lost) return now?.handingBack ?? Promise.resolve();
        now.handingBack ??= (async () => {
          const end = (await closingEnds([now])).get(now.claim.runId);
          if (now.ending || now.stopping || now.fence.lost) return;
          if (end) {
            now.cursor = Math.max(now.cursor, end.id);
            stopLoop(now, { kind: "command", commandId: end.id, ...(end.kind === "cancel" ? { cancel: true as const } : {}) });
            if (now.stopping) return;
          }
          stopLoop(now, { kind: "shutdown" });
          now.abort.abort(new Error("the runner is closing"));
        })();
        return now.handingBack;
      },
    });
    const held: Held = { passed: new Set(), claim, loop, fence, abort, cursor: 0, stopping: false, ending: false, landed: false, sealed: false, renewing: false, opened: false, delivering: false, deliverAgain: false, mib, ...(learningDeadline !== undefined && pastDeadline ? { learningDeadline, pastDeadline } : {}) };
    heldNow = held;
    // The loop's own end landed: the run is ending from here, its teardown included (no renew, no lost claim).
    ending = () => {
      held.ending = true;
      held.landed = true;
      clock.clearTimeout(held.deadline);
      clearTimeout(held.learningTimer);
    };
    runs.set(claim.runId, held);
    armDeadline(held, deadlineOf(claim, sentAt));
    armLearningDeadline(held);
    emit({ type: "claimed", claim });
    void announceStart(claim);
    const settled = after?.then(() => undefined, () => undefined);
    held.done = (async () => {
      if (settled) await settled;
      let end: LoopEnd;
      let threw = false;
      try {
        // A claim lost, or stopped by the runner's close, while it waited starts nothing: its process would take the run's
        // folders back from under whoever holds the run now. Its end is a stopped loop's, with nothing written.
        end = settled && (held.fence.lost || held.stopping || held.abort.signal.aborted || killed) ? { state: "interrupted" } : await loop.start(claim);
      } catch (error) {
        threw = true;
        // A claim refused before any loop could start (the dispatch's ClaimRefused: a harness this host never holds) is
        // for good: the run fails in its words, whatever woke it.
        end = error instanceof FrameTooLarge
          ? { state: "failed", error: { code: TOO_LARGE, message: `the run's records no longer fit the channel to its process (${error.message}), so it cannot go on` } }
          : { state: "failed", error: { code: error instanceof ClaimRefused ? CLAIM_REFUSED : "loop-threw", message: message(error) } };
      }
      await finish(held, end, threw);
    })();
    // The claim's first delivery, after its loop started: deps.delivered resolves once it has handed on every untaken row
    // it read. It opens the claim to deliveries (deliver): none reaches the loop before, so the first is the only one
    // under way and reads every row written until then itself, a reopen's included.
    const first = () => {
      held.opened = true;
      return deliver(held);
    };
    void (settled ? settled.then(first) : first()).finally(firstDelivered);
  };

  /** The claims this runner holds in the store, read back after a commit was answered Unanswered (it may have landed):
   *  bounded tries with a doubling wait; undefined when none answered, and the lease settles it then. */
  const readClaims = async (): Promise<Claim[] | undefined> => {
    for (let attempt = 0; attempt < UNKNOWN_READS && !killed && Date.now() < recoverBy; attempt++) {
      try {
        return await store.runs.claimsOf(name);
      } catch (error) {
        emit({ type: "error", step: "claim re-read", message: message(error) });
        // Never past the close's window: a recovery cannot hold a shutdown beyond the stop grace.
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(unknownBackoffMs * 2 ** attempt, Math.max(0, recoverBy - Date.now()))));
      }
    }
    return undefined;
  };
  /** Until close() sets it, no bound: the time by which every re-read after an Unanswered commit must be over, the same
   *  window as the close's stop (the lease less its margin), so a shutdown is never held longer than its grace allows. */
  let recoverBy = Infinity;
  /** Until close() sets it, no bound: the time by which a loop's tool hosts' release is cut (Runner.close: the stop's
   *  window less its margin, so the cut's booking lands inside it). */
  let releaseBy: number | undefined;
  /** The claims (`runId:epoch`) an ending with no loop is writing (endRetried): they live in `endings`, not in `runs`, so the
   *  sweep must not take them for claims nothing holds. */
  const endingClaims = new Set<string>();
  /** store.release, but a release answered Unanswered (it may or may not have landed) is read back: a claim still held at
   *  its epoch is released again (fenced on that epoch, as every write is), one gone is done. */
  const release = async (claim: Claim, options?: Parameters<RunnerStore["release"]>[1]): Promise<void> => {
    try {
      await store.release(claim, options);
    } catch (error) {
      if (!(error instanceof Unanswered)) throw error;
      for (let attempt = 0; attempt < UNKNOWN_READS; attempt++) {
        const mine = await readClaims();
        if (!mine) throw error;
        if (!mine.some((held) => held.runId === claim.runId && held.epoch === claim.epoch)) return;
        try {
          await store.release(claim, options);
          return;
        } catch (again) {
          if (!(again instanceof Unanswered)) throw again;
        }
      }
      throw error;
    }
  };
  /** A claim answered Unanswered may have landed, its run held under this runner with no loop on it until the lease ran
   *  out: read back, and every claim of this runner's that nothing here holds (nor `known`, claims of this poll not yet
   *  held) is released at once, fenced on its epoch, for any runner to take. */
  const giveBackUnknown = async (known: readonly Claim[]): Promise<void> => {
    // Several passes: the commit may land after a read that found nothing (it can still be pending on its old connection).
    for (let pass = 0; pass < UNKNOWN_SWEEPS; pass++) {
      if (pass > 0) {
        if (closed || killed) return;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(unknownBackoffMs * 2 ** pass, Math.max(0, recoverBy - Date.now()))));
      }
      const mine = await readClaims();
      if (!mine) return;
      for (const claim of mine) {
        if (runs.get(claim.runId)?.claim.epoch === claim.epoch || endingClaims.has(`${claim.runId}:${claim.epoch}`) || known.some((k) => k.runId === claim.runId && k.epoch === claim.epoch)) continue;
        emit({ type: "error", runId: claim.runId, step: "claim", message: `run ${claim.runId}: a claim answered Unanswered had landed (epoch ${claim.epoch}); given back` });
        await release(claim, {}).then(
          () => emit({ type: "handed-back", runId: claim.runId, epoch: claim.epoch, cause: "give_back" }),
          (error: unknown) => emit({ type: "error", runId: claim.runId, step: "claim give-back", message: message(error) }),
        );
      }
    }
  };

  const claimMore = async () => {
    if (polling || closed || killed) return;
    polling = true;
    try {
      const free = loops - runs.size - replaced.size;
      if (free <= 0) return;
      if (!(await gateOpen(false))) return;
      // By count alone, one store call claims the batch, each run at its own epoch + 1 (store.runs.claimMany): filling 300
      // loops, or taking a dead runner's runs over, is one transaction, not 300. By memory, each run that fits is claimed
      // on its own (claimByMemory).
      const sentAt = clock.now();
      const weights = new Map<string, number>();
      let claims: Claim[];
      try {
        claims = memory ? await claimByMemory(memory, free, weights) : await store.runs.claimMany(name, free, { leaseMs });
      } catch (error) {
        if (error instanceof Unanswered) await giveBackUnknown([]);
        throw error;
      }
      // Asked again, fresh, before any loop starts on what this poll claimed: a run claimed as the gate's answer changed is
      // given back untouched (released at its epoch, as a closing runner gives back a batch), for a runner that can serve it.
      if (claims.length > 0 && !(await gateOpen(true))) {
        for (const claim of claims) await release(claim, {}).catch((error: unknown) => emit({ type: "error", runId: claim.runId, step: "claim give-back", message: message(error) }));
        return;
      }
      // A claim whose run must only end, with no loop (endRetried), so no turn, model request or tool runs on it:
      // - a run stopped or cancelled while it had not started: claimed from queued, or claimed from running when an earlier
      //   claim was lost before the run's journal had anything (its runner gone before it wrote a word). Nothing of it
      //   starts now, not even its first input: a loop started first would send that input before the stop reached it;
      // - a run whose untaken stop row has tries, which failed to apply that stop before. Either source of tries counts: a
      //   refused stopped end (endRefused, released running) or a failed resume (resumeFailed's store.retry, released
      //   parked);
      // - a parked run stopped or cancelled whose computer its park kept pinned to another runner, or whose kept row can't
      //   be read (keptElsewhere): the store gives a stop to any runner at once, never waiting on the pin, and this
      //   runner can't reach that machine.
      //   A loop would take the kept row (takeKept) and try to attach it, orphaning it on that runner's host. Ending here,
      //   the run's end marks the row ending (run-end-computers.ts endingKept) before it deletes what its provider lists,
      //   so no follow-up claim takes that machine back; that runner's own timer at its time, or its janitor, ends the row.
      // One read of those claims' rows, made only when the batch has a queued or a released run.
      const reread = claims.filter((claim) => claim.from === "queued" || claim.from === "running" || claim.from === "parked");
      const rows = reread.length ? await store.commandsOf(reread.map((claim) => ({ runId: claim.runId, after: 0 }))) : new Map<string, Command[]>();
      // The learning children's deadlines among the batch, one read for all of it (learningDeadlinesOf), before any loop
      // starts on one: a batch whose read failed is given back whole, for a later claim to read again; a child at or past
      // its deadline on the learning clock only ends, cancelled as a person's cancel ends an unstarted run, so nothing of it
      // spends past the bound its run's caller was promised (learning_work.deadline_at).
      const deadlines = await learningDeadlinesOf(claims);
      for (const claim of claims) {
        if (!(deadlines instanceof Map)) {
          emit({ type: "error", runId: claim.runId, step: "learning deadline", message: deadlines.unread });
          await release(claim, {}).then(() => emit({ type: "handed-back", runId: claim.runId, epoch: claim.epoch, cause: "give_back" }), () => {});
          continue;
        }
        const deadline = deadlines.get(claim.runId);
        const overdue = deadline !== undefined && learningClock() >= deadline;
        let stop = endingRow((rows.get(claim.runId) ?? []).filter((row) => row.takenAt === null));
        if (overdue && stop?.kind !== "cancel") {
          emit({ type: "learning-deadline", runId: claim.runId });
          const cancelled = await sendCommand(store as CommandSink, claim.runId, { kind: "cancel", body: {} }).then(() => true, (error: unknown) => {
            emit({ type: "error", runId: claim.runId, step: "learning deadline", message: message(error) });
            return false;
          });
          if (!cancelled) {
            await release(claim, {}).catch(() => {});
            continue;
          }
          stop = endingRow((await store.commands(claim.runId, 0)).filter((row) => row.takenAt === null));
          if (!stop) {
            await release(claim, {}).catch(() => {});
            continue;
          }
        }
        const endsOnly = stop !== undefined && (overdue || claim.from === "queued" || stop.tries > 0 || (claim.from === "running" && (await neverStarted(claim))) || (claim.from === "parked" && (await keptElsewhere(claim))));
        if (stop && endsOnly && !closed && !killed && !runs.has(claim.runId)) {
          const key = `${claim.runId}:${claim.epoch}`;
          endingClaims.add(key);
          const ending = endRetried(claim, stop, overdue);
          endings.add(ending);
          void ending.finally(() => {
            endings.delete(ending);
            endingClaims.delete(key);
          });
          continue;
        }
        const before = runs.get(claim.runId);
        // A hold whose end landed holds nothing: that end commit released the run, and a message may have reopened it since.
        const holding = before !== undefined && !before.fence.lost && !before.landed;
        if (closed || killed || holding) {
          // Closed while the batch was claimed (or a run this runner still holds, which a claim cannot be): given back.
          if (holding) emit({ type: "error", runId: claim.runId, step: "claim", message: "claimed a run this runner still holds" });
          await release(claim, {}).then(() => emit({ type: "handed-back", runId: claim.runId, epoch: claim.epoch, cause: "give_back" }), () => {});
          continue;
        }
        try {
          // An earlier hold of the run still settling (a lost claim's loop, or an end that landed before a reopen) keeps its
          // place until it settles, and this claim's loop starts only then: its process's cleanup of the run's folders
          // (a slot's reap, its scratch swept) never runs under the next one's.
          if (before?.done) {
            replaced.add(before);
            void before.done.finally(() => replaced.delete(before));
          }
          hold(claim, sentAt, weights.get(claim.runId) ?? 0, deadline, before?.done);
        } catch (error) {
          // The loop could not be made: the run fails here, so it is not claimed again and again.
          emit({ type: "error", runId: claim.runId, step: "create loop", message: message(error) });
          await store.runs.update(claim, { state: "failed", summary: redact(message(error)), ...(await censusFor(claim.runId)) }).catch(() => {});
          await store.flush().catch(() => {});
          await release(claim, {}).catch(() => {});
        }
      }
    } catch (error) {
      emit({ type: "error", step: "poll", message: message(error) });
    } finally {
      polling = false;
    }
  };
  /** Up to `free` waiting runs, oldest first, while they fit `memory`'s budget beside what this runner holds (a lost
   *  claim's loop still running holds its weight too): each claimed on its own, its weight put in `weights`. The first that
   *  does not fit ends the claim, unless the runner holds nothing: then it is claimed alone. */
  const claimByMemory = async (budget: RunnerMemory, free: number, weights: Map<string, number>): Promise<Claim[]> => {
    // As this runner's claimer: a run whose computer is kept for another runner still there is not among them.
    const waiting = await store.runs.claimable({ limit: free, runner: name });
    if (waiting.length === 0) return [];
    const weighed = await budget.weigh(waiting);
    let heldMib = [...runs.values(), ...replaced].reduce((sum, held) => sum + held.mib, 0);
    let holding = runs.size + replaced.size;
    const claims: Claim[] = [];
    for (const runId of waiting) {
      const mib = weighed.get(runId) ?? 0;
      if (holding > 0 && heldMib + mib > budget.budgetMib) break;
      if (closed || killed) break;
      // Another runner may have taken it since the read: then it is not this one's, and the next is tried. A claim that
      // throws ends this poll's claims, keeping those that landed: they are held below, never left claimed and unstarted.
      let claim: Claim | null;
      try {
        claim = await store.claim(runId, name, { leaseMs });
      } catch (error) {
        emit({ type: "error", runId, step: "claim", message: message(error) });
        if (error instanceof Unanswered) await giveBackUnknown(claims);
        break;
      }
      if (!claim) continue;
      claims.push(claim);
      weights.set(runId, mib);
      heldMib += mib;
      holding += 1;
    }
    return claims;
  };
  /** The claim gate's last answer (RunnerOptions.claimGate): null while it lets this runner claim. */
  let refusing: string | null = null;
  /** Whether this runner may claim now (claimGate), its presence row and its lines told at each change of answer. A gate
   *  that throws is said, and claims nothing this poll; its last answer stands. */
  const gateOpen = async (fresh: boolean): Promise<boolean> => {
    if (!options.claimGate) return true;
    let words: string | undefined;
    try {
      words = await options.claimGate(fresh);
    } catch (error) {
      emit({ type: "error", step: "claim gate", message: message(error) });
      return false;
    }
    const now = words ?? null;
    if (now !== refusing) {
      refusing = now;
      emit({ type: "refusing", reason: now });
      await (options.presence ?? presence)?.refuse(now).catch(() => undefined);
    }
    return now === null;
  };
  /** The poll's claim in flight, if any: close() waits for it, so a runner whose close resolved claims nothing after it. */
  let claiming: Promise<void> | undefined;
  /** A run was queued while a poll was in flight (claimNow): one more poll follows that poll's end at once. */
  let pollAgain = false;
  /** The learning deadlines of the learning children among a poll's `claims` (a check's replay, an audit's shadow: each
   *  its launch's, learning-work.ts LEARNING_CHILD_MS), in one read for the whole batch (store.runs.learningDeadlines),
   *  before any loop starts on one: a run that is no learning child is absent, and a store without that read or without
   *  commands (a test's) has none. `{ unread }` when the read failed: the batch is given back for a later claim to read
   *  again. */
  const learningDeadlinesOf = async (claims: readonly Claim[]): Promise<Map<string, number> | { unread: string }> => {
    if (claims.length === 0 || !store.runs.learningDeadlines || !store.command) return new Map();
    try {
      return await store.runs.learningDeadlines(claims.map((claim) => claim.runId));
    } catch (error) {
      return { unread: message(error) };
    }
  };
  /** Held learning child `held` at its deadline on the learning clock: its loop sends no model request more (its
   *  pastDeadline signal, which its request gate reads before each), and it is cancelled as a person's cancel is (a cancel
   *  row, its loop's ordinary stop: its spend booked once at its end, its copy of a key erased by that end's write), that
   *  row handed to its loop at once, never at the next command tick. Serve has no run deadline, so this is what bounds a
   *  learning child's spend on its run's key (learning_work.deadline_at). A cancel not written is tried again at the next
   *  poll (endOverdue); its gate stays shut meanwhile. */
  const cancelOverdue = (held: Held) => {
    if (held.overdue || held.ending || held.fence.lost) return;
    held.overdue = true;
    held.pastDeadline?.abort();
    emit({ type: "learning-deadline", runId: held.claim.runId });
    if (!store.command) return;
    void sendCommand(store as CommandSink, held.claim.runId, { kind: "cancel", body: {} }).then(
      () => {
        if (held.sealed || !delivering()) return;
        if (held.delivering) held.deliverAgain = true;
        else void deliver(held);
      },
      (error: unknown) => {
        // Final already: it ended on its own.
        if (error instanceof RunFinal) return;
        held.overdue = false;
        emit({ type: "error", runId: held.claim.runId, step: "learning deadline", message: message(error) });
      },
    );
  };
  /** Held learning child `held`'s deadline, on the learning clock: cancelOverdue at it, by a timer on its own (re-armed
   *  while the deadline is past a timer's longest wait), so neither waits for a poll. */
  const armLearningDeadline = (held: Held) => {
    if (held.learningDeadline === undefined || held.ending || held.sealed) return;
    const wait = held.learningDeadline - learningClock();
    if (wait <= 0) return cancelOverdue(held);
    // Unref'd: a runner killed with the child held (a crash) leaves nothing that keeps its process up.
    held.learningTimer = setTimeout(() => armLearningDeadline(held), Math.min(wait, MAX_TIMER_MS)).unref();
  };
  /** Every held learning child at its deadline on the learning clock (cancelOverdue), swept at each poll: the timer's
   *  backstop, and a cancel that was not written tried again. */
  const endOverdue = () => {
    const at = learningClock();
    for (const held of runs.values()) if (held.learningDeadline !== undefined && at >= held.learningDeadline) cancelOverdue(held);
  };
  const poll = () => {
    if (closed || killed) return;
    clearTimeout(pollTimer);
    pollAgain = false;
    beat();
    endOverdue();
    const claimed = claimMore();
    claiming = claimed;
    void claimed.finally(() => {
      if (claiming === claimed) claiming = undefined;
      if (closed || killed) return;
      if (pollAgain) poll();
      else pollTimer = setTimeout(poll, pollMs);
    });
  };
  /** A run queued through a store in this process (store.watchCommands' "queued"): claimed now, not up to a whole poll
   *  later. A poll in flight may have read the runs before it was queued, so one more follows that poll's end. */
  const claimNow = () => {
    if (closed || killed) return;
    if (claiming) pollAgain = true;
    else poll();
  };

  // Its word in the store that a runner that claims is here (presence.ts), for as long as it runs: a server reads a
  // refusal left by an earlier runner as over once this is there. One its caller keeps is its caller's to close.
  const presence = options.presence ? undefined : store.runners ? keepPresence(store.runners, name, null, { warn: (line) => emit({ type: "error", step: "presence", message: line }), slots: loops, ...(options.incarnation ? { incarnation: options.incarnation } : {}) }) : undefined;
  // Its incarnation, read once here before the first poll: each claim's computer and the stop's kept-row check use it.
  const incarnation = (options.presence ?? presence)?.incarnation;
  poll();
  commandTimer = setTimeout(deliverAll, commandPollMs);
  // A run queued in this process is claimed now (claimNow). A command written for a run this runner holds is handed on
  // now, not at the next poll. A delivery already in flight marks the run, and one more delivery follows its end, so a row
  // written mid-delivery is never left to the next poll.
  unwatchCommands = store.watchCommands(({ runId, what }) => {
    if (what === "queued") return claimNow();
    if (what !== "written" || !delivering()) return;
    const held = runs.get(runId);
    if (held === undefined) return;
    if (held.delivering) held.deliverAgain = true;
    else void deliver(held);
  });

  /** The untaken stop or cancel row each of `going` ends on (endingRow: a cancel before a stop), past its cursor, by run id:
   *  the close's one read of their rows (store.commandsOf), after the deliveries in flight. The whole of it is bounded by
   *  the stop margin, so a store that stalls never holds the shutdown: a read that fails or runs past it is said, and those
   *  runs are released for a shutdown as before, their rows untaken for the next claim. */
  const closingEnds = async (going: readonly Held[]): Promise<Map<string, Command>> => {
    const ends = new Map<string, Command>();
    if (going.length === 0) return ends;
    const read = async (): Promise<Map<string, Command>> => {
      // A delivery in flight finishes first: it may be handing on that same row.
      await Promise.all(going.map((held) => held.inFlight?.catch(() => undefined)));
      const still = going.filter((held) => !held.stopping && !held.ending && !held.fence.lost);
      if (still.length === 0) return ends;
      const rows = await store.commandsOf(still.map((held) => ({ runId: held.claim.runId, after: held.cursor })));
      const found = new Map<string, Command>();
      for (const held of still) {
        const end = endingRow((rows.get(held.claim.runId) ?? []).filter((row) => row.takenAt === null));
        if (end) found.set(held.claim.runId, end);
      }
      return found;
    };
    let bound: NodeJS.Timeout | undefined;
    // Within the close's stop window (the lease less its margin), whatever the margin.
    const boundMs = Math.min(stopMarginMs, leaseMs - stopMarginMs);
    const late = new Promise<"late">((resolve) => (bound = setTimeout(() => resolve("late"), boundMs)));
    // A read that fails after the bound is never an unhandled rejection: the close has moved on without it.
    const reading = read();
    reading.catch(() => undefined);
    try {
      const found = await Promise.race([reading, late]);
      if (found !== "late") return found;
      for (const held of going) emit({ type: "error", runId: held.claim.runId, step: "commands", message: `the close's read of its stop rows took longer than ${boundMs} ms: released for the next claim` });
    } catch (error) {
      for (const held of going) emit({ type: "error", runId: held.claim.runId, step: "commands", message: message(error) });
    } finally {
      clearTimeout(bound);
    }
    return ends;
  };

  const stopTimers = () => {
    clearTimeout(pollTimer);
    clearTimeout(commandTimer);
    unwatchCommands?.();
    clearInterval(renewTimer);
    for (const held of runs.values()) clock.clearTimeout(held.deadline);
  };

  return {
    name,
    ...(incarnation ? { incarnation } : {}),
    held: () => [...runs.values()].filter((held) => !held.fence.lost && !held.ending).map((held) => held.claim),
    async close(loopsStopping?: (by: number) => void) {
      if (closed || killed) return;
      closed = true;
      const closedAt = Date.now();
      // What its caller stops when told (a ChatGPT renewal) is served RUNNER_RENEWALS_SERVED_MS at most, or to the drain's
      // end: a renewal sent then is over inside every shipped grace, whatever the drain (the CLI's is 30 s).
      let told = false;
      const tell = (by: number) => {
        if (told) return;
        told = true;
        clearTimeout(servedTimer);
        loopsStopping?.(by);
      };
      const servedTimer = setTimeout(() => tell(Date.now() + leaseMs - stopMarginMs), RUNNER_RENEWALS_SERVED_MS);
      clearTimeout(pollTimer);
      // `what`, or the time `at` (ms since the epoch), whichever comes first; at once when there is nothing to wait for.
      const until = async (at: number, what: Promise<unknown> | undefined): Promise<void> => {
        if (!what) return;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([what, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, at - Date.now()))))]);
        clearTimeout(timer);
      };
      // A claim the poll has in flight lands while the runner closes: one it makes now is given back at once (claimMore,
      // closed), and close waits for it before it resolves, so nothing is claimed by this runner after it (a raise sent
      // then wakes no claim here). A claim recovery under way (re-reads after an Unanswered commit) is bound by the close's
      // own window (claimBy: the lease less its margin from the close's start), past which the lease settles what the
      // recovery had not. That wait runs beside the drain and the loops' stop, never ahead of them: runnerCloseBoundMs
      // counts the drain and one window, and a wait of its own before the drain would add a window to the close.
      draining = drainMs > 0;
      const claimBy = closedAt + leaseMs - stopMarginMs;
      recoverBy = claimBy;
      // The drain: each held run goes on to its own end (an answer, a park, a person's stop: their commands still reach
      // them), its claims renewed, for up to drainMs from the close's start; a turn in flight then finishes, never cut
      // and paid again on the resume. Whatever is still going at the bound is stopped below, for a shutdown, where it can
      // resume.
      const going = [...runs.values()].filter((held) => !held.fence.lost && !held.ending);
      const drainFrom = Date.now();
      if (draining && going.length > 0) {
        let bound: NodeJS.Timeout | undefined;
        await Promise.race([Promise.all(going.map((held) => held.done)), new Promise<void>((resolve) => (bound = setTimeout(resolve, drainMs)))]);
        clearTimeout(bound);
      }
      draining = false;
      // How long the drain took, and what it left for the shutdown to hand back (the runner's metrics: runner-metrics.ts).
      if (going.length > 0) emit({ type: "drained", ms: Date.now() - drainFrom, held: going.length, left: going.filter((held) => !held.ending && !held.fence.lost).length });
      clearTimeout(commandTimer);
      const live = [...runs.values()].filter((held) => !held.fence.lost);
      // One window for the stop after the drain, the one runnerCloseBoundMs counts (runnerStopBy): the read below and
      // the loops' stop, their tool hosts' release included, share it, so the close is never longer than a deployment's
      // stop grace allows for.
      const stopBy = runnerStopBy(closedAt, Date.now(), leaseMs, stopMarginMs, cleanupMs, releaseMarginMs);
      recoverBy = stopBy;
      // A loop's release is cut the stop's margin or the release's margin (its cut's booking) before the window ends,
      // whichever is longer (runnerReserveMs), so its cut and what it books land inside it, its claim still renewed.
      releaseBy = stopBy - runnerReserveMs(stopMarginMs, releaseMarginMs);
      // A stop or cancel a person sent before the close is the run's end, never a resume: one no delivery has handed on
      // yet (the command poll's tick had not come) is read here, once, for every run still going, and stops its loop as
      // its delivery would. Its end is in the store when the close is done, and the next start never resumes the turn.
      const ends = await closingEnds(live.filter((held) => !held.ending && !held.stopping));
      for (const held of live) {
        if (held.ending) continue;
        const end = ends.get(held.claim.runId);
        if (end && !held.stopping) {
          held.cursor = Math.max(held.cursor, end.id);
          stopLoop(held, { kind: "command", commandId: end.id, ...(end.kind === "cancel" ? { cancel: true as const } : {}) });
        }
        // A loop a stop or cancel already stops writes that end: it is never cut for the close, but its release under way
        // is cut by the close's window (releaseBy), as a shutdown's would be.
        if (held.stopping) {
          held.loop.closing?.();
          continue;
        }
        stopLoop(held, { kind: "shutdown" });
        held.abort.abort(new Error("the runner is closing"));
      }
      // The drain is over and every loop left is stopping, for a shutdown that resumes: what a drained run might need
      // until now can stop (unless RUNNER_RENEWALS_SERVED_MS stopped it already). What its caller waits for from here gets
      // a whole window, so a renewal sent while the read above stalled still has its full wait; the tell is never later
      // than RUNNER_RENEWALS_SERVED_MS, so that wait ends inside RUNNER_RENEWAL_BOUND_MS.
      tell(Date.now() + leaseMs - stopMarginMs);
      // Claims are renewed while the loops stop; a loop that never stops is given up at the end of the window the read
      // above began (runnerStopBy). A claim still in flight is waited for up to claimBy, inside that window.
      await until(stopBy, Promise.all([...live.map((held) => held.done), ...endings, until(claimBy, claiming)]));
      // A lost create's recovery in this process (one under way at the close's start, or one a create the stop cut began)
      // ends before the close does, so the browser it finds is released before the process goes: each waited for to
      // its own bound from the close's start, or the drain, whichever is later, and its margin, within the window.
      await recoveriesDone(closedAt, drainMs, stopBy, releaseMarginMs);
      // A loop still going at the window's end (one a stop row stops, whose signal was kept whole for its end) has its
      // signal aborted before its claim is given up: no request of it outlives the close.
      for (const held of live) if (!held.ending && !held.abort.signal.aborted) held.abort.abort(new Error("the runner is closing"));
      for (const held of runs.values()) held.fence.lost = true;
      stopTimers();
      // The live view's last tick, once every loop has ended or been given up: a draining run kept its live view to the
      // end of its loop.
      await ticker?.close();
      // It claims no more: its word that it is here goes.
      await presence?.close();
      // Its runs' trace spans still waiting in the batch are sent, at most FLUSH_MS (nothing when tracing is off).
      await flushTraces();
    },
    kill() {
      killed = true;
      closed = true;
      stopTimers();
      // A crash says nothing more: its word goes stale, as a dead runner's does.
      presence?.stop();
      // A crash writes nothing more: the live view's ticker stops at once, beside a new holder of its runs.
      ticker?.stop();
    },
  };
}
