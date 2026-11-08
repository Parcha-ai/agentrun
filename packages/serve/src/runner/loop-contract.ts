// The contract between a runner and the loop that runs one claimed run (design: "Runners carry many loops"). The runner
// claims, renews, delivers command rows and releases; the loop runs the harness on the run's journal. B2's loop.ts
// implements `Loop` for pi and the CLI adapters; the runner knows nothing about harnesses.

import type { Claim, Command, Journal } from "../store/store.js";

// The store's own: a claim (its epoch fences every write made under it; `until` in epoch ms) and a command row (taken_at
// set once, by the loop's journal commit that applies it or by the runner's refusal, with `refused` its reason).
export type { Claim, Command, Journal };

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
  /** A stop row: the loop stages that row's take in the commit that ends the run as stopped. */
  | { readonly kind: "command"; readonly commandId: number }
  /** The runner could not renew before the claim ran out (or was fenced): the loop must write nothing more. */
  | { readonly kind: "claim-lost" }
  /** The runner is closing: the loop stops where it can resume, and the run is released to another runner. */
  | { readonly kind: "shutdown" };

/** A command handed to a loop: "taken" means its take is staged in the journal commit that applies it. */
export type CommandOutcome = { readonly taken: true } | { readonly refused: string };

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
}

export type LoopFactory = (deps: LoopDeps) => Loop;
