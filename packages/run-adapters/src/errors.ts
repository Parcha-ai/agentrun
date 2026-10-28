/** Why a harness node delivered no record. */
export type HarnessRunReason =
  | "aborted" | "timeout" | "turn_limit" | "submission_limit" | "no_submission" | "model_error"
  /** Turns kept ending with no paid request and no accepted submission (`NO_PROGRESS_TURNS` in a row), which the turn
   *  limit never counts: the harness is not reaching its model. */
  | "no_progress"
  /** The runner or the host refused the node before or while it ran: an unknown tool, a fork, a turn limit above the
   *  host's cap, a session the adapter refused, or the host's `beforeRequest` (a budget). */
  | "refused"
  /** A newer process opened this node's session, so this attempt may no longer write it: it stops and delivers nothing.
   *  Not final: whether the step is delivered is the newer attempt's to say. */
  | "fenced";

/** An append through a writer that a newer `open` of its session has fenced. Nothing of the append was written. */
export class SessionFenced extends Error {
  readonly code = "SESSION_FENCED";
  constructor(readonly key: string) {
    super(`session ${key}: a newer writer holds it; this append was refused`);
    this.name = "SessionFenced";
  }
}

/** A node that delivered no record. `final` says a second attempt would end the same way, so a recovery driver gives
 *  it none: the runner's own bounds (the turn cap, no progress, a refusal) are final; an abort, a timeout or a model
 *  error is not. */
export class HarnessRunError extends Error {
  readonly code = "HARNESS_NODE_NOT_DELIVERED";
  readonly final?: true;
  constructor(
    readonly reason: HarnessRunReason,
    readonly turns: number,
    readonly submissions: number,
    detail: { message?: string; maxTurns?: number | null; lastTool?: string } = {},
  ) {
    super(detail.message ?? `harness node stopped: ${reason} after ${turns} turns and ${submissions} submissions`);
    this.name = "HarnessRunError";
    if (detail.maxTurns !== undefined) this.maxTurns = detail.maxTurns;
    if (detail.lastTool !== undefined) this.lastTool = detail.lastTool;
    if (reason === "turn_limit" || reason === "no_progress" || reason === "refused") this.final = true;
  }
  /** The node's turn limit for this attempt, or null when it had none. */
  readonly maxTurns?: number | null;
  /** The name of the last tool the node called, never its arguments. */
  readonly lastTool?: string;
}
