// How a turn whose drive was aborted ends, written for AgentRun. The session's own stop (its interrupt, or its close) and
// its host's are an interruption; anything else that halted the drive (a spend cap, the transcript mirror, a refused
// spawn) said why, and the turn ends failed with that reason, never as interrupted with it dropped.
import type { TurnStatus } from "../types.js";

/** The session's own stop of its drive: told apart from every other halt by identity, never by its text. */
export class SessionHalt extends Error {
  constructor(readonly kind: "interrupted" | "closed") {
    super(kind);
    this.name = "SessionHalt";
  }
}

/** The outcome of a turn whose drive `signal` was aborted, the session's host being `host`. */
export function abortedOutcome(signal: AbortSignal, host?: AbortSignal): { status: TurnStatus; error?: string } {
  const reason: unknown = signal.reason;
  if (reason instanceof SessionHalt || host?.aborted) return { status: "interrupted" };
  const message = reason instanceof Error ? reason.message : reason === undefined ? "the turn was halted, with no reason given" : String(reason);
  return { status: "failed", error: message.slice(0, 500) };
}
