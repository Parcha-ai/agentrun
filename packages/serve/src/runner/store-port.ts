// The part of the store (module A, store/store.ts) a runner calls. A's SqliteStore satisfies it as it is; the runner
// names only this, so no SQL, pragma or file reaches runner/. Until A lands, the reds run on a double of it.
import type { Claim, Command } from "./loop-contract.js";

export interface RunnerStore<Journal extends object> {
  runs: {
    /** Run ids a claim may take, oldest first: queued; parked with an untaken command or a passed wake time; running
     *  with no live claim (released, or claimed_until passed). */
    claimable(options: { limit: number }): Promise<string[]>;
    /** The run row's fenced update (state, summary): used only when a loop broke its contract by throwing. */
    update(claim: Claim, patch: { state: "failed"; summary?: string }): Promise<void>;
  };
  /** epoch + 1 and the claim, or null when another runner holds a live claim or the run is final. */
  claim(runId: string, runner: string, options: { leaseMs: number }): Promise<Claim | null>;
  /** The same epoch with a later `until`; rejects Fenced when the epoch moved. */
  renew(claim: Claim, options: { leaseMs: number }): Promise<Claim>;
  /** No runner, no claimed_until; `wakeAt` sets the run's wake time (a park). Rejects Fenced when the epoch moved. */
  release(claim: Claim, options?: { wakeAt?: number }): Promise<void>;
  journal(claim: Claim): Journal;
  flush(): Promise<void>;
  /** Rows for the run with an id above `after`, oldest first. */
  commands(runId: string, after: number): Promise<Command[]>;
  /** Sets a command's taken_at (and `refused`, the reason, for a refusal) where it is untaken, fenced on the claim's
   *  epoch. A loop's take goes in its journal commit instead (stage({ take })); the runner takes only refusals. */
  take(claim: Claim, commandId: number, outcome: "taken" | "refused", reason?: string): Promise<void>;
}

/** The store's fence: a write under an epoch that moved. Matched by name, the same class A exports. */
export function isFenced(error: unknown): boolean {
  return error instanceof Error && error.name === "Fenced";
}
