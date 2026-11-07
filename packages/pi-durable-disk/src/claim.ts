// The claim: what a run's instance holds while it runs. On a local directory (`localRun`) the directory is the claim, and
// the store's own lock keeps a second writer out.
import { ClaimError } from "./errors.ts";

export type RunRef = { disk: string; region: string; id: string };

export interface AcquireOptions {
  ref: RunRef;
}

export interface Claim {
  readonly ref: RunRef;
  readonly disk: string;
  readonly root: string;
  readonly work: string;
  readonly store: string;
  readonly fenced: boolean;
  /** Mark the claim lost (the store's facade calls this on an I/O-class error); later barriers throw at once. */
  markFenced(cause?: unknown): void;
  /**
   * Where the run's environment records the commands it starts, so that the next open of this claim ends what a killed
   * incarnation left running (`reapCommands`, before the Harness opens).
   */
  readonly commands?: string;
  /** Refuses once the claim is fenced. On a local directory it syncs nothing: the store's commits are made durable by SQLite, and work/ is the operating system's to flush. */
  barrier(): Promise<{ ms: number }>;
  /** Barrier, then let go of the claim. */
  release(): Promise<{ via: Unmounted }>;
}

/** How a claim let go of its directory: a local directory has nothing to unmount. */
export type Unmounted = "none";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function runPath(id: string): string {
  if (!RUN_ID.test(id)) throw new ClaimError("INVALID_ARGUMENT", `run id ${JSON.stringify(id)} is not one safe path segment`);
  return `runs/${id}`;
}
