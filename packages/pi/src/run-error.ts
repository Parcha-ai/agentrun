// Kept apart from runner.ts so the workflow service loads without a pi package installed.
export class PiRunError extends Error {
  constructor(public readonly reason: "aborted" | "timeout" | "turn_limit" | "submission_limit" | "no_submission" | "model_error", public readonly turns: number, public readonly submissions: number) {
    super(`Pi node did not deliver an accepted submission: ${reason} (${turns} turns, ${submissions} submissions)`);
    this.name = "PiRunError";
  }
}
