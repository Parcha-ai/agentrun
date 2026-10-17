export type LearnErrorCode = "invalid" | "format" | "missing" | "rules_locked" | "too_large" | "contended" | "judge";

/** The one error this package throws. Its message never carries a value a guard refused. */
export class LearnError extends Error {
  /**
   * `invalid`: an argument breaks the contract (a run id, a sha, a ref, a directory).
   * `format`: a learning file does not parse.
   * `missing`: no such ref or commit.
   * `rules_locked`: a write names `agent.json` or `AGENTS.md`.
   * `too_large`: a value is over its cap.
   * `contended`: another writer kept moving main; curation stopped after its retries.
   * `judge`: the judge failed or answered out of shape; curation stopped before the run it was judging.
   */
  readonly code: LearnErrorCode;

  constructor(code: LearnErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LearnError";
    this.code = code;
  }
}
