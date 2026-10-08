// Typed errors and exit codes shared by every module. An instance that loses its run exits 75 (fenced) or 76 (held by
// another); both are terminal for the host's process supervisor, which must not restart into a run it lost.
// A module's own errors extend FencedError or HeldError (overriding `code`) so one `instanceof` or `exitCodeFor` covers
// them all, e.g. `class StoreFencedError extends FencedError` with `{ code: "STORE_FENCED" }`.

/** EX_TEMPFAIL: the claim was revoked or its mount failed; nothing this process writes can become durable. */
export const EXIT_FENCED = 75;
/**
 * Someone else holds the run: another client's delegation, another process's owner lock, another store connection. A
 * held delegation is live or orphaned (its client gone); the supervisor revokes orphans.
 */
export const EXIT_HELD = 76;

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

/** The claim is lost or its mount failed. Never retried on the same handle; the process exits 75. */
export class FencedError extends PdaError {
  constructor(message: string, options: { cause?: unknown; code?: string } = {}) {
    super(options.code ?? "FENCED", message, { cause: options.cause, exitCode: EXIT_FENCED });
  }
}

export type Holder = "claim" | "owner-lock" | "store";
const HELD_CODES: Record<Holder, string> = { claim: "CLAIM_HELD", "owner-lock": "OWNER_LOCK_HELD", store: "STORE_BUSY" };

/** Someone else holds the run (see `Holder`). The process exits 76. */
export class HeldError extends PdaError {
  readonly holder: Holder;
  constructor(holder: Holder, message: string, options: { cause?: unknown; code?: string } = {}) {
    super(options.code ?? HELD_CODES[holder], message, { cause: options.cause, exitCode: EXIT_HELD });
    this.holder = holder;
  }
}

export type ClaimErrorCode =
  | "INVALID_ARGUMENT"
  | "MOUNTPOINT_BUSY"
  | "MOUNTPOINT_NOT_EMPTY"
  | "MOUNT_FAILED"
  | "CLAIM_NOT_VERIFIED"
  | "ARCHIL_CLI_FAILED"
  | "UNMOUNT_FAILED"
  | "DEAD_MOUNT_CLEANUP_FAILED"
  | "CLAIM_RELEASED"
  | "CONTROL_API_FAILED";

/** Any other claim failure (bad input, a refused or unverifiable mount, a CLI or control API failure). Exit 1. */
export class ClaimError extends PdaError {
  constructor(code: ClaimErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

export function exitCodeFor(err: unknown): number {
  return err instanceof PdaError ? err.exitCode : 1;
}

/**
 * Any error writing a file the claim owns (its probe, `run.json`, `owner.lock`, the run directory itself) is a fence. A
 * revoked mount answers such writes with EIO, EROFS, ENOENT, SQLITE_CANTOPEN or a success into its local cache,
 * so no errno is evidence that the claim is still held. Taking the owner lock is not a write: a lock
 * another process holds is `HeldError("owner-lock")`.
 */
export function ownWriteFenced(what: string, cause: unknown): FencedError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new FencedError(`writing ${what} failed, so the claim cannot be trusted: ${reason}`, { cause });
}
