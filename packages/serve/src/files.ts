// The small JSON files the server reads and writes beside the agent store.
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Json } from "./validate.js";

/** The server's own file in each run's directory: the run's title, input and how it was asked to run. */
export const RUN_META = "serve.json";
/** A cancelled run's mark in its directory, written before its process is told: the run's process sends no model
 *  request once it is there, however the cancel and the process's start interleave. */
export const RUN_CANCELLED = "cancelled";
/** A run's launch mark in its directory, written before its process is spawned and removed once that process serves
 *  or exits: found at a start, the server went down while it launched the run. */
export const RUN_LAUNCHING = "launching";
/** Why a run fails whose launch mark a start finds (`error.details.reason`, openapi.ts). */
export const LAUNCH_LOST = "server_lost_at_launch";

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

/** Writes `text` to `path` whole and durably: the temporary file is synced before the rename, and the directory after it,
 *  so once this resolves a crash, even of the machine, leaves the new text in place, never the old or none. */
export async function writeDurable(path: string, text: string, mode = 0o600): Promise<void> {
  // Its own temporary file: a box's record can be let go by two settlements at once (a run's archive and its agent's).
  const temp = tempOf(path);
  const bytes = Buffer.from(text);
  const file = await open(temp, "w", mode);
  try {
    // Every byte, or an error: a short write (a disk nearly full) is never synced and renamed as if whole.
    for (let at = 0; at < bytes.length; ) {
      const { bytesWritten } = await file.write(bytes, at, bytes.length - at);
      if (bytesWritten <= 0) throw new Error(`${temp}: wrote ${at} of ${bytes.length} bytes`);
      at += bytesWritten;
    }
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temp).catch(() => {});
    throw error;
  }
  await file.close();
  await rename(temp, path);
  const dir = await open(dirname(path), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
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

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const HELD_PATHS = existsSync("/proc/self/fd");

/** Writes `data` as a new file `name` in `dirs` below the run's `work`, never through a link: a box's command can plant
 *  one there, and this process writes with the server's rights. Each directory is made when missing and opened without
 *  following a link, the next reached through the one held before it (`/proc/self/fd`), and the file is created, never
 *  replaced: a link in the way refuses the write (ELOOP, ENOTDIR or EEXIST). Without /proc, each step is reached by its
 *  path, which a link swapped in between two steps could still turn. */
export async function writeInWork(work: string, dirs: readonly string[], name: string, data: string | Uint8Array): Promise<void> {
  let dir = await open(work, DIRECTORY);
  let path = work;
  const below = (part: string) => (HELD_PATHS ? `/proc/self/fd/${dir.fd}/${part}` : join(path, part));
  try {
    for (const part of dirs) {
      await mkdir(below(part)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const next = await open(below(part), DIRECTORY);
      await dir.close();
      [dir, path] = [next, join(path, part)];
    }
    const file = await open(below(name), NEW_FILE, 0o644);
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
  } finally {
    await dir.close();
  }
}
