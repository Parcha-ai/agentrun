// A run's own files on this machine (localPlace's `readRunFile` and `listRunFiles`): read only, never a write, never the
// claim, and never through a symlink. A read sees what the holder has written; a file the holder writes whole (a temp
// file, then a rename) is never seen half-written. What a file means is the reader's business: disk parses none of them.
import { constants } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { PdaError } from "./errors.ts";

export type RunFileErrorCode = "INVALID_PATH" | "RUN_MISSING" | "NOT_A_FILE" | "CONTROL_API_FAILED";

/** A read of a run's files that cannot be answered. Its message names the path, never what a file holds. */
export class RunFileError extends PdaError {
  declare readonly code: RunFileErrorCode;
  constructor(code: RunFileErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

/**
 * What is wrong with `path` as a relative path of safe segments inside the run, or null when nothing is. The answer names
 * the fault only, never the path, which may hold anything a caller passed.
 */
function pathFault(path: string, allowRoot: boolean): string | null {
  if (path === "") return allowRoot ? null : "it is empty";
  if (path.startsWith("/")) return "it is absolute";
  const unsafe = path.search(/[^A-Za-z0-9._/-]/);
  if (unsafe >= 0) return `it has an unsafe character at index ${unsafe}`;
  const segments = path.split("/");
  if (segments.includes("")) return "it has an empty segment";
  if (segments.includes(".")) return 'it has a "." segment';
  if (segments.includes("..")) return 'it has a ".." segment';
  return null;
}

/** The segments of `path`, or INVALID_PATH naming what is wrong (never the path). `""` is the run's root where allowed. */
export function runFileSegments(path: string, allowRoot: boolean): string[] {
  const fault = pathFault(path, allowRoot);
  if (fault !== null) throw new RunFileError("INVALID_PATH", `not a relative path of safe segments (letters, digits, ".", "_", "-") inside the run: ${fault}`);
  return path === "" ? [] : path.split("/");
}

const fsCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

async function localRunMissing(root: string, id: string): Promise<void> {
  try {
    if ((await stat(root)).isDirectory()) return;
  } catch (error) {
    if (fsCode(error) !== "ENOENT" && fsCode(error) !== "ENOTDIR") throw new RunFileError("CONTROL_API_FAILED", `reading run ${id} failed`, { cause: error });
  }
  throw new RunFileError("RUN_MISSING", `there is no run ${id} on this machine`);
}

/**
 * Walk `segments` under `root` with lstat: a symlink anywhere on the way is NOT_A_FILE (never followed, so nothing outside
 * the run is ever read). Resolves with the last path and what it is, or null when something on the way is not there.
 */
async function walk(root: string, id: string, path: string, segments: string[]): Promise<{ at: string; dir: boolean } | null> {
  let at = root;
  for (const [i, segment] of segments.entries()) {
    at = join(at, segment);
    let st;
    try {
      st = await lstat(at);
    } catch (error) {
      if (fsCode(error) === "ENOENT" || fsCode(error) === "ENOTDIR") return null;
      throw new RunFileError("CONTROL_API_FAILED", `reading ${path} in run ${id} failed`, { cause: error });
    }
    if (st.isSymbolicLink()) throw new RunFileError("NOT_A_FILE", `${path} in run ${id} goes through a symlink, which is never followed`);
    if (i < segments.length - 1 && !st.isDirectory()) return null;
    if (i === segments.length - 1) return { at, dir: st.isDirectory() };
  }
  return { at, dir: true };
}

/**
 * The bytes of the run's file `path` in the run directory `root` on this machine, or null when there is none. A directory, or a symlink
 * anywhere on the way, is NOT_A_FILE, and a file swapped for a link after the check is refused, not followed.
 */
export async function readLocalRunFile(root: string, id: string, path: string): Promise<Uint8Array | null> {
  const segments = runFileSegments(path, false);
  await localRunMissing(root, id);
  const found = await walk(root, id, path, segments);
  if (!found) return null;
  if (found.dir) throw new RunFileError("NOT_A_FILE", `${path} in run ${id} is a directory`);
  let handle;
  try {
    handle = await open(found.at, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw new RunFileError("NOT_A_FILE", `${path} in run ${id} is not a regular file`);
    return new Uint8Array(await handle.readFile());
  } catch (error) {
    if (error instanceof RunFileError) throw error;
    if (fsCode(error) === "ELOOP") throw new RunFileError("NOT_A_FILE", `${path} in run ${id} is a symlink, which is never followed`);
    if (fsCode(error) === "ENOENT") return null;
    throw new RunFileError("CONTROL_API_FAILED", `reading ${path} in run ${id} failed`, { cause: error });
  } finally {
    await handle?.close();
  }
}

/** The names directly under `dir` in the run directory `root` on this machine, sorted; a symlink on the way is NOT_A_FILE. */
export async function listLocalRunFiles(root: string, id: string, dir: string): Promise<string[]> {
  const segments = runFileSegments(dir, true);
  await localRunMissing(root, id);
  const found = await walk(root, id, dir, segments);
  if (!found || !found.dir) return [];
  try {
    return (await readdir(found.at)).sort();
  } catch (error) {
    if (fsCode(error) === "ENOENT" || fsCode(error) === "ENOTDIR") return [];
    throw new RunFileError("CONTROL_API_FAILED", `listing ${dir || "the run"} of run ${id} failed`, { cause: error });
  }
}
