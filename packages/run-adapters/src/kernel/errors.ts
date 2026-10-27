// The errors the copied harness code throws and catches, by the names it uses. Written for AgentRun.
import type { EffectError } from "./types.js";

/** An effect failed; `error` is what its records say. A memoized failure is thrown again as this. */
export class EffectFailure extends Error {
  constructor(readonly error: EffectError) {
    super(error.message);
    this.name = "EffectFailure";
  }
}

/** An effect was stopped before it reported its outcome. */
export class EffectInterrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectInterrupted";
  }
}

/** Rebuild the drive from the session's records, in this process. */
export class Restart extends Error {
  constructor(reason: string) {
    super(`restart: ${reason}`);
    this.name = "Restart";
  }
}

/** The session's records cannot be used as they are (a missing blob): no rebuild helps. */
export class Fatal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Fatal";
  }
}

/** The harness cannot run this turn (no sandbox, a version mismatch, a cap reached); the turn ends with this text. */
export class Unavailable extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(message: string, options: { code?: string; hint?: string } = {}) {
    super(message);
    this.name = "Unavailable";
    this.code = options.code ?? "unavailable";
    if (options.hint !== undefined) this.hint = options.hint;
  }
}
