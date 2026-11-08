// The contract between a runner and the loop that runs one claimed run (design: "Runners carry many loops"). The runner
// claims, renews, delivers command rows and releases; the loop runs the harness on the run's journal. B2's loop.ts
// implements `Loop` for pi and the CLI adapters; the runner knows nothing about harnesses.

import { refusedText } from "../refusal-words.js";
import type { AlsoRow, Claim, Command, Journal } from "../store/store.js";

// The store's own: a claim (its epoch fences every write made under it; `until` in epoch ms) and a command row (taken_at
// set once, by the loop's journal commit that applies it or by the runner's refusal, with `refused` its reason).
export type { AlsoRow, Claim, Command, Journal };

/** How an end-of-run turn the loop asked ended: its answer's text, its deadline passed (the turn is aborted), or it
 *  failed. */
export type EndOfRunAnswer = { readonly ended: true; readonly answer: string } | { readonly timedOut: true } | { readonly failed: { readonly code: string; readonly message: string } };

/**
 * The end-of-run step (the learning lane's end-of-run turn): asked once, after the job's last turn ended and before the
 * loop writes the run's end. `ask` sends one more turn through the run's own session, its origin `reflect`: while it
 * runs the loop refuses its writes and edits under work/.learning/ (REFLECT_NOTE_ONLY), and it is aborted at
 * `deadlineMs`. The rows it returns are staged into the end commit, so they land in that commit's one transaction or not
 * at all. A stop or a lost claim aborts `signal`: no end is written, and the next claim asks again (the turn's request
 * id is one per run, so its model is asked once).
 */
export type EndOfRunTurn = (input: {
  readonly runId: string;
  readonly agentId: string;
  readonly claim: Claim;
  /** How the job ended. */
  readonly outcome: "completed" | "failed";
  /** The run was cut before it could look back: by a person's stop (`stopped`), by one during the end-of-run turn
   *  (`stopped-looking`), or by a fault (`faulted`). The step must not call `ask`: it returns only what a cut run keeps. */
  readonly cut?: "stopped" | "stopped-looking" | "faulted";
  ask(prompt: string, opts: { readonly origin: "reflect"; readonly deadlineMs: number }): Promise<EndOfRunAnswer>;
  readonly signal: AbortSignal;
}) => Promise<{ readonly also: readonly AlsoRow[] } | undefined>;

/** How a loop's start() ended. The run's own outcome (state, cost) is already in the journal's last commit. */
export type LoopEnd =
  | { readonly state: "ended" | "stopped" }
  /** Stopped on claim-lost or shutdown with no end written: the run stays running, and the next claim resumes it. */
  | { readonly state: "interrupted" }
  | { readonly state: "failed"; readonly error: { readonly code: string; readonly message: string } }
  /** Parked on a person (an approval, a raise): the runner flushes and releases; a command row (or `wakeAt`, ms since
   *  the epoch) makes the run claimable again, and the next claim's start() resumes it from the journal. */
  | { readonly state: "parked"; readonly wakeAt?: number };

export type StopReason =
  /** A stop or cancel row: the loop stages that row's take in the commit that ends the run as stopped (`cancel`: a cancel
   *  row, whose end says so, in main's words). */
  | { readonly kind: "command"; readonly commandId: number; readonly cancel?: true }
  /** The runner could not renew before the claim ran out (or was fenced): the loop must write nothing more. */
  | { readonly kind: "claim-lost" }
  /** The runner is closing: the loop stops where it can resume, and the run is released to another runner. */
  | { readonly kind: "shutdown" };

/** The end a person's stop or cancel writes: stopped, in words that say which. A cancel's are main's ("cancelled"). */
export function endedBy(cancel: boolean | undefined): string {
  return cancel ? "cancelled" : "stopped by a person";
}

/** The refusal a denied call's model reads: serve's own words for a call a person denied (refusal-words.ts refusedText,
 *  one copy with the tool gate's), the person's note with it. Asked before its intent, the call never ran. */
export function deniedText(tool: string, note?: string): string {
  return refusedText(tool, note?.trim() ? note : undefined, "no");
}

/** An approve's or deny's note (body.note, the person's words), as its answer entry keeps it: absent when blank. */
export function noteOf(command: Command): { note?: string } {
  const note = (command.body as { note?: unknown } | null)?.note;
  return typeof note === "string" && note.trim() !== "" ? { note } : {};
}

/** A command handed to a loop: "taken" means its take is staged in the journal commit that applies it. */
/** A command's outcome: `taken` (the loop's own commit took it, with its effect), `refused` (the runner takes it as
 *  refused, saying why), or `later` (neither: the row stays untaken for the run's next claim, which hands it on again;
 *  a steer that comes as the run parks is its resume's, never refused). */
export type CommandOutcome = { readonly taken: true } | { readonly refused: string } | { readonly later: string };

export interface Loop {
  /** Runs the claimed run until it ends, parks or is stopped. A run's own failure resolves as `failed`; a throw is a
   *  bug the runner records as the run failing. */
  start(claim: Claim): Promise<LoopEnd>;
  /** steer, approve, deny, raise. Never stop: that comes as stop(). */
  command(command: Command): Promise<CommandOutcome>;
  /** Aborts the in-flight turn; resolves once the loop will write nothing more. */
  stop(reason: StopReason): Promise<void>;
}

export interface LoopDeps {
  /** The run's journal (store.journal(claim)) behind the runner's own fence: after a claim-lost stop, a commit is
   *  refused (ClaimLost) before it reaches the store. */
  journal(claim: Claim): Journal;
  /** One durable commit for every earlier one: before a call that must not run twice. */
  flush(): Promise<void>;
  /** Aborted on claim loss, self-stop or shutdown: in-flight model and tool calls are cut at once. */
  signal: AbortSignal;
  /** The end-of-run step (EndOfRunTurn): asked once before a run that answered or failed writes its end. Absent: none. */
  endOfRun?: EndOfRunTurn;
  /** Resolves once the claim's first delivery has handed every untaken row it read to command() (each call returned),
   *  or at once when there were none: a resumed ask with no answer row waits for it before it parks again, so an
   *  approve already on its way is never raced. Never rejects. */
  delivered?: Promise<void>;
  /** Where the loop reports what its run shows before it is stored (a running tool, a partial answer), as it changes: a
   *  reader of the newest held state (`undefined` once there is nothing held), called once per tick by the runner's live
   *  ticker (runner/live-ticker.ts), never on every change, so a change costs the same however long the answer has grown.
   *  The ticker writes it to the run's run_live row, one store transaction per tick for all its loops, never into the
   *  journal. Absent: not reported. */
  live?: (read: () => HeldState | undefined) => void;
}

/** A run's held state: what pi shows before it stores it. The live view (live/stream.ts) streams it beside the stored
 *  commits' events, in the door's vocabulary (a running tool's tool_execution_start, a partial's message_update). */
export interface HeldState {
  readonly tools: readonly { readonly callId: string; readonly name: string; readonly args?: unknown; readonly output?: string }[];
  readonly partial?: { readonly text: string };
}

export type LoopFactory = (deps: LoopDeps) => Loop;
