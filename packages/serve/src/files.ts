// The small JSON files the server reads and writes beside the agent store.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, type Stats, unlinkSync, writeSync } from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { agentDiskDir } from "@parcha/pi-durable-agent";
import { dirname, join, resolve } from "node:path";
import type { Json } from "./validate.js";

/** The server's own file in each run's directory: the run's title, input and how it was asked to run. */
export const RUN_META = "serve.json";
/** A cancelled run's mark in its directory, written before its process is told: the run's process sends no model
 *  request once it is there, however the cancel and the process's start interleave. */
export const RUN_CANCELLED = "cancelled";
/** A run's launch mark in its directory, written before its process is spawned and removed once that process serves
 *  or exits: found at a start, the server went down while it launched the run. */
export const RUN_LAUNCHING = "launching";
/** Set in a run's process environment when the server opens the run for a person's follow-up to a run whose turn had
 *  ended (it answered, or the person stopped it): that open resumes no cut work, so it writes no "resumed" row (app.ts). */
export const FOLLOW_UP_OPEN_ENV = "AGENTRUN_FOLLOW_UP_OPEN";
/** The server's API token (`ar_local_...`), in the data directory, made at its first start when it is given none. */
export const TOKEN_FILE = ".token";
/** The server-wide door token, in the data directory: the door of a run an older server started takes it. */
export const DOOR_TOKEN_FILE = ".door-token";
/** A run's own door token, in its directory, made at its first launch and handed to its process alone (its
 *  `--serve-token-file`): the server's calls to that run's door carry it, and so do that run's calls to the box relay
 *  (box-relay.ts), which takes a call for a run only with that run's token. */
export const RUN_DOOR_TOKEN = "door-token";

/** Run directory `dir`'s own door token (RUN_DOOR_TOKEN), when it has one. */
export function runDoorToken(dir: string): string | undefined {
  try {
    const token = readFileSync(join(dir, RUN_DOOR_TOKEN), "utf8").trim();
    return token && !/\s/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}
/** Why a run fails whose launch mark a start finds (`error.details.reason`, openapi.ts). */
export const LAUNCH_LOST = "server_lost_at_launch";
/** Why a run fails that the store has running with no serve.json: its server went down before it set the run up. */
export const SETUP_LOST = "server_lost_at_setup";

/** The server's data directory when none is given (`--data`): `agentrun/agents` under XDG_DATA_HOME, or ~/.local/share.
 *  The server, its import and reset-password default to it. `npx @parcha/agentrun` keeps its own, ~/.agentrun, and
 *  passes it as --data. */
export const defaultData = (env: NodeJS.ProcessEnv = process.env): string => join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "agentrun", "agents");
/** The server's own data directory, on its reading of the environment (startServe): an npx hint names it (adapters.ts
 *  npxLine). */
export const DATA_ENV = "AGENTRUN_SERVE_DATA";

/** The data directory a run's folder is in: `<data>/disk/agents/<agent>/runs/<run>` (pi-durable-agent runDirIn). */
export const dataOfRun = (runDir: string): string => resolve(runDir, "..", "..", "..", "..", "..");

/** Agent `agentId`'s folder on the disk, which holds its learning folder (learning.ts) and its runs: `<data>/disk/agents/<agent>`. */
export const agentFolderOf = (data: string, agentId: string): string => agentDiskDir(data, agentId);

export const HOMES_DIR = "homes";
/** Paths in an agent's home that only the host reads and writes (another component owns them): the home API reads and
 *  writes neither, and lists each by its name alone. `learning` (learning.ts, read through its own API) and `sign-ins`
 *  (sign-ins.ts: the agent's saved sign-ins, sealed pointers to its browser vendor's objects, shown without them on
 *  GET /agents/{id}). */
export const HOME_HOST_OWNED = ["learning", "sign-ins"];
/** An agent's home directory's name: its id in lower case, then 16 hex digits of the id's SHA-256. Ids that differ only
 *  in case get names that differ in any case, so on a disk that folds case (macOS's, by default) they never share one. */
export const homeKey = (agentId: string): string => `${agentId.toLowerCase()}-${createHash("sha256").update(agentId, "utf8").digest("hex").slice(0, 16)}`;
export const homeOf = (data: string, agentId: string): string => join(data, HOMES_DIR, homeKey(agentId));

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
