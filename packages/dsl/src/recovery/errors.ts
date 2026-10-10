/** The one error family of durable recovery. A failure of the journal itself (a store that will not open, write or
 *  bind, a checkpoint or execution path the driver refuses, a host pause or cancel, an effect whose outcome is unknown
 *  and must be reconciled) is a RecoveryError. A host stops a run on one and never hands the run to a fallback: the
 *  persistence guarantees rest on that. Every other failure of a workflow is the workflow's own. */
export class RecoveryError extends Error {
  readonly code: string;
  readonly transient = false;
  /** The family's failures are typed: a context object marks `code` as the error's kind for a host that reports
   *  failures structurally. */
  readonly context: Record<string, never> = {};
  /** Who issued the host's pause or cancel this failure is, as the host named it. */
  readonly source?: string;
  constructor(message: string, code = "RECEIPTS_FAILURE", options?: { cause?: unknown; source?: string }) {
    super(message, options);
    this.name = "RecoveryError";
    this.code = code;
    if (options?.source) this.source = options.source;
  }
}

/** The stop a typed failure code names: a run ends by pause or cancel at the site that consumed the command (a session
 *  under run control, the recovery driver), each with its own code, and a host reads the stop back from the code. */
const STOP_CODES: Record<string, "pause" | "cancel"> = { RUN_PAUSED: "pause", RUN_CANCELLED: "cancel", FROZEN_PAUSED: "pause", FROZEN_CANCELLED: "cancel" };

/** The failure a session under run control raises when its run was paused or cancelled. */
export const runStoppedError = (stop: "pause" | "cancel", source?: string) => new RecoveryError(`Run ${stop} requested`, stop === "pause" ? "RUN_PAUSED" : "RUN_CANCELLED", { source });

/** The pause or cancel that stopped a run and who issued it (the user unless the host named another), read from a
 *  RecoveryError anywhere in an error's cause chain; null for every other failure. */
export function runStopOf(error: unknown): { stop: "pause" | "cancel"; code: string; source: string } | null {
  for (let current = error, depth = 0; current && depth < 16; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (current instanceof RecoveryError && STOP_CODES[current.code]) return { stop: STOP_CODES[current.code], code: current.code, source: current.source ?? "user" };
  }
  return null;
}

/** A failure raised inside a store or the driver, as a RecoveryError: the original message and code are kept, the
 *  original error is its cause. */
export function asRecoveryError(error: unknown): RecoveryError {
  if (error instanceof RecoveryError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof (error as any)?.code === "string" ? (error as any).code : "RECEIPTS_FAILURE";
  return new RecoveryError(message, code, { cause: error });
}

/** Whether an error, or any error in its cause chain, is a RecoveryError. */
export function isRecoveryError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 16; current = (current as any).cause, depth += 1) {
    if (current instanceof RecoveryError) return true;
  }
  return false;
}
