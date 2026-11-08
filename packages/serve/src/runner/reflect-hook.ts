// The learning lane's end-of-run turn on the runner (loop-contract.ts EndOfRunTurn): whether a run looks back, its
// prompt, what its turn answered checked into a proposal, and the rows that keep it beside the run's end
// (learning_proposals, and a queued learning run when there is something to grade).
import type { EndOfRunTurn } from "./loop-contract.js";

/** What the hook reads of the run and the host. */
export interface ReflectDeps {
  readonly facts: (runId: string) => Promise<unknown>;
}

/** The end-of-run turn for runs that learn. */
export function createReflectHook(_deps: ReflectDeps): EndOfRunTurn {
  return async () => undefined;
}
