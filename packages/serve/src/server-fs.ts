// The server's own durable-file plumbing: the few helpers that read and write the files the server keeps beside its store,
// and where that store lives. Split out of files.ts so the run-directory markers and the per-run door's files (which the
// runner cutover deletes) can go on their own. Nothing here knows a run: it is whole-file writes made durable, a directory
// sync, a JSON read that fails to null, a per-key work queue, the data-directory location and the names of the two files
// the owner's CLI reads (the API token and the server record).
import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, type Stats, unlinkSync, writeSync } from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentDiskDir } from "@parcha/pi-durable-agent";
import type { Json } from "./validate.js";

/** The server's API token (`ar_local_...`), in the data directory, made at its first start when it is given none. */
export const TOKEN_FILE = ".token";
/** Where a running server is, for the launcher's CLI (`npx @parcha/agentrun agents list`), in the data directory: its
 *  base URL, its pid and its token's file, never the token. Written once it listens, mode 0600; removed on a clean exit. */
export const SERVER_FILE = ".server.json";

/** Removes the SERVER_FILE record at `file` only while it names process `pid`: a record another server wrote stays.
 *  Never throws; a record it cannot read is not this process's. */
export function removeOwnRecord(file: string, pid = process.pid): void {
  try {
    if ((JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown } | null)?.pid === pid) unlinkSync(file);
  } catch {
    // Gone already, unreadable or not this process's: nothing to remove.
  }
}

/** The server's data directory when none is given (`--data`): `agentrun/agents` under XDG_DATA_HOME, or ~/.local/share.
 *  The server, its import and reset-password default to it. `npx @parcha/agentrun` keeps its own, ~/.agentrun, and
 *  passes it as --data. */
export const defaultData = (env: NodeJS.ProcessEnv = process.env): string => join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "agentrun", "agents");
/** The server's own data directory, on its reading of the environment (startServe): an npx hint names it (adapters.ts
 *  npxLine). */
export const DATA_ENV = "AGENTRUN_SERVE_DATA";

/** Agent `agentId`'s folder on the disk, which holds its learning folder (learning.ts) and its runs: `<data>/disk/agents/<agent>`. */
export const agentFolderOf = (data: string, agentId: string): string => agentDiskDir(data, agentId);

/** The file parsed as JSON, or null when it is missing, unreadable, or not whole JSON (a half-written file). */
export const readJson = (path: string): Promise<Json | null> =>
  readFile(path, "utf8")
    .then((text) => JSON.parse(text) as Json)
    .catch(() => null);

/** A temporary file beside `path`, this write's own: two writes of one file at once never share one, so neither renames
 *  the other's away nor writes into the file the other renamed. */
export const tempOf = (path: string): string => `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;

/** Writes `text` to `path` whole: through a temporary file and a rename, so a reader never sees half of it. */
export async function writeWhole(path: string, text: string, mode = 0o600): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, text, { mode });
  await rename(temp, path);
}

/** Syncs the directory `path`, so the entries made in it survive a crash of the machine. */
export async function syncDir(path: string): Promise<void> {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/** Writes `text` (or bytes) to `path` whole and durably: the temporary file is synced before the rename, and the
 *  directory after it, so once this resolves a crash, even of the machine, leaves the new text in place, never the old or
 *  none. `temp` is the temporary file, created only if nothing is there yet: a link planted at it is never written through.
 *  Answers the stats of the file it wrote, read before the rename: a write of `path` that lands after it is not them.
 *  `exact`: the file gets `mode` itself, whatever this process's umask takes away (set on its handle, never by path). */
export async function writeDurable(path: string, text: string | Uint8Array, mode = 0o600, temp = tempOf(path), exact = false): Promise<Stats> {
  // Its own temporary file: a box's record can be let go by two settlements at once (a run's archive and its agent's).
  const bytes = typeof text === "string" ? Buffer.from(text) : text;
  const file = await open(temp, "wx", mode);
  let stats: Stats;
  try {
    if (exact) await file.chmod(mode);
    // Every byte, or an error: a short write (a disk nearly full) is never synced and renamed as if whole.
    for (let at = 0; at < bytes.length; ) {
      const { bytesWritten } = await file.write(bytes, at, bytes.length - at);
      if (bytesWritten <= 0) throw new Error(`${temp}: wrote ${at} of ${bytes.length} bytes`);
      at += bytesWritten;
    }
    await file.sync();
    stats = await file.stat();
  } catch (error) {
    await file.close();
    await unlink(temp).catch(() => {});
    throw error;
  }
  await file.close();
  await rename(temp, path).catch(async (error) => {
    await unlink(temp).catch(() => {});
    throw error;
  });
  await syncDir(dirname(path));
  return stats;
}

/** writeDurable, synchronously: on disk, the file and then its directory synced, when it returns. For a record that
 *  must be durable before the next line runs, with nothing between them that could let anything else happen first. */
export function writeDurableSync(path: string, text: string, mode = 0o600): void {
  const temp = `${path}.tmp`;
  const bytes = Buffer.from(text);
  const file = openSync(temp, "w", mode);
  try {
    // Every byte, or an error: a short write (a disk nearly full) is never synced and renamed as if whole.
    for (let at = 0; at < bytes.length; ) {
      const written = writeSync(file, bytes, at, bytes.length - at);
      if (written <= 0) throw new Error(`${temp}: wrote ${at} of ${bytes.length} bytes`);
      at += written;
    }
    fsyncSync(file);
  } catch (error) {
    closeSync(file);
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
  closeSync(file);
  renameSync(temp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** Runs `work` once every call queued before it under `key` in `queues` has settled: one at a time per key. The queue
 *  holds only settled turns, so one that failed never fails the next, and a key is dropped once its last turn settles. */
export function serialBy<T>(queues: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
  const turn = (queues.get(key) ?? Promise.resolve()).then(work);
  const settled = turn.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => queues.get(key) === settled && queues.delete(key));
  return turn;
}
