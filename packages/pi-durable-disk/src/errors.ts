// Typed errors and exit codes shared by every module. An instance that loses its run exits 75 (fenced) or 76 (held by
// another); both are terminal for the host's process supervisor, which must not restart into a run it lost.
// A module's own errors extend FencedError or HeldError (overriding `code`) so one `instanceof` or `exitCodeFor` covers
// them all, e.g. `class StoreFencedError extends FencedError` with `{ code: "STORE_FENCED" }`.

/** EX_DATAERR: the run's data refuses to open (an unreadable record); a restart cannot help. */
export const EXIT_DATAERR = 65;
/** EX_SOFTWARE: this package cannot read the head of pi's store (pi's schema moved); a restart cannot help. */
export const EXIT_SOFTWARE = 70;
/** EX_TEMPFAIL: the claim was revoked or its mount failed; nothing this process writes can become durable. */
export const EXIT_FENCED = 75;
/**
 * Someone else holds the run: another store connection, or a process a killed incarnation's commands left alive.
 */
export const EXIT_HELD = 76;
/** EX_CONFIG: the host launched a run with no box to run it in (`boxMode: "unavailable"`); a restart on this server cannot help. */
export const EXIT_CONFIG = 78;

export class PdaError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, options: { cause?: unknown; exitCode?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** The host gave an open `boxMode: "unavailable"`: there is no box to run it in. Refused before the claim is taken, so
 *  nothing is opened, run or written; the run is held until a server with a box opens it. Exit 78. */
export class BoxUnavailableError extends PdaError {
  constructor() {
    super("BOX_UNAVAILABLE", "this run's box is unavailable on this server: it is held until a server with a box opens it", { exitCode: EXIT_CONFIG });
  }
}

/** The claim is lost or its mount failed. Never retried on the same handle; the process exits 75. */
export class FencedError extends PdaError {
  constructor(message: string, options: { cause?: unknown; code?: string } = {}) {
    super(options.code ?? "FENCED", message, { cause: options.cause, exitCode: EXIT_FENCED });
  }
}

/** `commands`: processes a killed incarnation's commands left that did not die when the next open killed them. */
export type Holder = "claim" | "store" | "commands";
const HELD_CODES: Record<Holder, string> = { claim: "CLAIM_HELD", store: "STORE_BUSY", commands: "COMMANDS_ALIVE" };

/** Someone else holds the run (see `Holder`). The process exits 76. */
export class HeldError extends PdaError {
  readonly holder: Holder;
  constructor(holder: Holder, message: string, options: { cause?: unknown; code?: string } = {}) {
    super(options.code ?? HELD_CODES[holder], message, { cause: options.cause, exitCode: EXIT_HELD });
    this.holder = holder;
  }
}

export type ClaimErrorCode = "INVALID_ARGUMENT";

/** A claim refused for bad input (a run id that is not one safe path segment). Exit 1. */
export class ClaimError extends PdaError {
  constructor(code: ClaimErrorCode, message: string, options: { cause?: unknown; exitCode?: number } = {}) {
    super(code, message, options);
  }
}

export function exitCodeFor(err: unknown): number {
  return err instanceof PdaError ? err.exitCode : 1;
}

/**
 * Any error writing a file the claim owns (its layout, the run directory itself) is a fence: no errno is evidence that
 * the claim is still sound. Trying the store's lock is not a write: a store another process holds is `HeldError("store")`.
 */
export function ownWriteFenced(what: string, cause: unknown): FencedError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new FencedError(`writing ${what} failed, so the claim cannot be trusted: ${reason}`, { cause });
}
