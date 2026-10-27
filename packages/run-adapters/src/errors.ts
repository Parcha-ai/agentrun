/** Why a harness node delivered no record. */
export type HarnessRunReason =
  | "aborted" | "timeout" | "turn_limit" | "submission_limit" | "no_submission" | "model_error"
  /** The runner or the host refused the node before or while it ran: an unknown tool, a fork, a turn limit above the
   *  host's cap, a session the adapter refused, or the host's `beforeRequest` (a budget). */
  | "refused";

/** A node that delivered no record. `final` says a second attempt would end the same way, so a recovery driver gives
 *  it none: the runner's own bounds (the turn cap, a refusal) are final; an abort, a timeout or a model error is not. */
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
    if (reason === "turn_limit" || reason === "refused") this.final = true;
  }
  /** The node's turn limit for this attempt, or null when it had none. */
  readonly maxTurns?: number | null;
  /** The name of the last tool the node called, never its arguments. */
  readonly lastTool?: string;
}
