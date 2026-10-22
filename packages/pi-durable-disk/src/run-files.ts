// A run's own files, read over the disk's control (S3 GET, HEAD and LIST) and nothing else: these calls never mount, never
// write, and never take or wait on the run's claim, so anyone may read a run another host holds. A read sees what the
// holder has synced (its last barrier), and a file the holder writes whole (a temp file, then a link or a rename) is never
// seen half-written. What a file means is the reader's business: disk parses none of them.
//
// How Archil's S3 API answers, measured on archil 0.8.42: a missing key is 404; a directory is a marker key ending in "/";
// a symlink is listed as an ordinary zero-byte key, but its HEAD and GET answer 501 NotImplemented, and S3 never follows a
// link. So a symlink is told on a read's 501, never from a listing.
import { runPath, type RunRef } from "./claim.ts";
import { PdaError } from "./errors.ts";

/** The calls of the disk's control these reads use; `archilControl` has all three. */
export interface RunFileControl {
  getObject(key: string): Promise<Uint8Array>;
  /** null when there is no such key. */
  headObject(key: string): Promise<unknown | null>;
  listObjects(prefix: string, options?: { recursive?: boolean }): Promise<{ objects: { key: string; size?: number }[]; commonPrefixes?: string[] }>;
}

export type RunFileErrorCode = "INVALID_PATH" | "RUN_MISSING" | "NOT_A_FILE" | "CONTROL_API_FAILED";

/** A read of a run's files that cannot be answered. Its message names the path, never what a file holds. */
export class RunFileError extends PdaError {
  declare readonly code: RunFileErrorCode;
  constructor(code: RunFileErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The run's key prefix and `path` under it, or INVALID_PATH: relative, safe segments only, never `.`, `..` or `.archil/`. */
function keyOf(ref: RunRef, path: string, allowRoot: boolean): { run: string; key: string } {
  const run = `${runPath(ref.id)}/`;
  if (path === "" && allowRoot) return { run, key: run };
  const segments = path.split("/");
  if (path === "" || segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..") || segments[0] === ".archil") {
    throw new RunFileError("INVALID_PATH", `${JSON.stringify(path)} is not a relative path of safe segments (letters, digits, ".", "_", "-") inside the run`);
  }
  return { run, key: `${run}${path}` };
}

const statusOf = (error: unknown): unknown => (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
const missing = (error: unknown) => statusOf(error) === 404 || (error as { code?: unknown })?.code === "NoSuchKey";
const notImplemented = (error: unknown) => statusOf(error) === 501 || (error as { code?: unknown })?.code === "NotImplemented";

/** `call`, ended at once when `signal` aborts (the request itself may still finish; nothing waits on it). */
function bounded<T>(call: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return call();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    call().then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e: unknown) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

/** A control call; any failure but the ones the caller handles is CONTROL_API_FAILED, an abort stays the caller's. */
async function ask<T>(what: string, call: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  try {
    return await bounded(call, signal);
  } catch (error) {
    if (signal?.aborted && error === signal.reason) throw error;
    throw error instanceof RunFileError ? error : new RunFileError("CONTROL_API_FAILED", `${what} over the control failed`, { cause: error });
  }
}

async function runMissing(control: RunFileControl, run: string, ref: RunRef, signal: AbortSignal | undefined): Promise<void> {
  if ((await ask(`reading ${run}`, () => control.headObject(run), signal)) === null) throw new RunFileError("RUN_MISSING", `there is no run ${ref.id} on this disk`);
}

/**
 * The bytes of `path` in the run (`runs/<id>/<path>`), or null when there is no such file yet, so a poller waits. A
 * directory or a symlink is NOT_A_FILE; a run that does not exist is RUN_MISSING. No polling here: the caller bounds its
 * own wait, with `signal` and its own retries.
 */
export async function readRunFile(control: RunFileControl, ref: RunRef, path: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | null> {
  const { signal } = options;
  const { run, key } = keyOf(ref, path, false);
  signal?.throwIfAborted();
  try {
    return await bounded(() => control.getObject(key), signal);
  } catch (error) {
    if (signal?.aborted && error === signal.reason) throw error;
    if (notImplemented(error)) throw new RunFileError("NOT_A_FILE", `${path} in run ${ref.id} is not a regular file (a symlink: the S3 API reads only files)`, { cause: error });
    if (!missing(error)) throw new RunFileError("CONTROL_API_FAILED", `reading ${path} in run ${ref.id} over the control failed`, { cause: error });
  }
  // Not there: a directory of that name, no run at all, or a file not written yet.
  if ((await ask(`reading ${path}/`, () => control.headObject(`${key}/`), signal)) !== null) throw new RunFileError("NOT_A_FILE", `${path} in run ${ref.id} is a directory`);
  await runMissing(control, run, ref, signal);
  return null;
}

/**
 * The names directly under `dir` in the run (`""` for the run's root), sorted: files and directories alike, names only,
 * never a claim about what each one is. A directory not made yet lists nothing; a run that does not exist is RUN_MISSING.
 */
export async function listRunFiles(control: RunFileControl, ref: RunRef, dir: string, options: { signal?: AbortSignal } = {}): Promise<string[]> {
  const { signal } = options;
  const { run, key } = keyOf(ref, dir, true);
  const prefix = key.endsWith("/") ? key : `${key}/`;
  const listed = await ask(`listing ${dir || "the run"} of run ${ref.id}`, () => control.listObjects(prefix, { recursive: false }), signal);
  const names = new Set<string>();
  for (const k of [...listed.objects.map((o) => o.key), ...(listed.commonPrefixes ?? [])]) {
    if (!k.startsWith(prefix)) continue;
    const name = k.slice(prefix.length).replace(/\/$/, "");
    if (name !== "" && !name.includes("/")) names.add(name);
  }
  if (names.size === 0) await runMissing(control, run, ref, signal);
  return [...names].sort();
}
