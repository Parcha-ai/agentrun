// Kept apart from runner.ts so the workflow service loads without a pi package installed.
export class PiRunError extends Error {
  /** The node's turn limit for this attempt, or null when it had none. */
  public readonly maxTurns?: number | null;
  /** The name of the last tool the node called, never its arguments. */
  public readonly lastTool?: string;
  /** A turn limit ends the step: a fresh session with the same prompt and limit would spend the same again, so a
   *  recovery driver gives it no second attempt. */
  public readonly final?: true;
  constructor(public readonly reason: "aborted" | "timeout" | "turn_limit" | "submission_limit" | "no_submission" | "model_error", public readonly turns: number, public readonly submissions: number,
    progress: { maxTurns?: number | null; lastTool?: string } = {}) {
    super(`Pi node did not deliver an accepted submission: ${reason} (${turns} turns, ${submissions} submissions)`);
    this.name = "PiRunError";
    if (progress.maxTurns !== undefined) this.maxTurns = progress.maxTurns;
    if (progress.lastTool !== undefined) this.lastTool = progress.lastTool;
    if (reason === "turn_limit") this.final = true;
  }
}
