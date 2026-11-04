// One server per data root, written for AgentRun. A server takes <data>/server.lock before anything reads or writes the
// data root, and holds it until it closes; a second server on the same root is refused by name and touches nothing.
//
// The lock is SQLite's EXCLUSIVE lock, as pi-durable-disk's owner.lock: held on one connection for the server's life,
// dropped by the kernel when the process dies (a crashed server's file is reused by the next start, never refused for
// existing), and refused to a second connection whether it is in another process or in this one. The file is opened by
// SQLite alone: a POSIX lock is dropped when any descriptor the process holds on the file is closed, so no other code
// may open it (its mode is set by path).
//
// pi-durable-disk forgets a command record written in another pid namespace only under the precondition this lock
// keeps: two servers never hold one data root at once.
//
// A server that stops keeps the lock until its runs' processes have drained and exited, which takes up to their drain
// and a second. It says so in <data>/server.state: written once as the server starts, right after it takes the lock
// (its pid, not stopping), and rewritten in place as its close begins (when its stop is over at the latest). A stop never
// adds an entry to the data root, so a caller that removes the directory as soon as it signals the stop meets nothing
// new there. A start that finds the lock held reads that file only then, and waits for a server that is stopping instead
// of refusing it; a record whose pid is gone or whose time has passed is no stop.
import { chmodSync, closeSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { sqliteBusy } from "./agents.js";

export const SERVER_LOCK = "server.lock";
/** The data root's server, as it last said: `{ pid, until }`, `until` (epoch ms) when it stops, null while it runs. */
export const SERVER_STATE = "server.state";
/** The record's length on disk: its JSON padded with spaces, so a rewrite in place leaves no tail of an earlier one. */
const STATE_BYTES = 128;
const stateOf = (until: number | null) => Buffer.from(JSON.stringify({ pid: process.pid, until }).padEnd(STATE_BYTES - 1) + "\n");

/** Another server holds the data root. Its message is the one line the CLI prints before it exits 1. */
export class ServerLockHeldError extends Error {
  readonly code = "SERVER_LOCK_HELD";
  readonly file: string;
  constructor(file: string, options?: { cause?: unknown }) {
    super(`another server holds this data root (${file}): stop it, or start this one with another --data`, options);
    this.name = "ServerLockHeldError";
    this.file = file;
  }
}

/** A held server lock: released once, by the server's close. */
export interface ServerLock {
  readonly file: string;
  release(): void;
}

/** Takes the data root's server lock, or throws ServerLockHeldError while another server (in any process) holds it.
 *  Anything that fails after the lock is taken (its mode, on a filesystem that refuses one) closes the connection, so
 *  the lock is dropped before the error reaches the caller. `options.chmod` is for tests. */
export function takeServerLock(dataRoot: string, options: { chmod?: (file: string, mode: number) => void } = {}): ServerLock {
  const file = join(dataRoot, SERVER_LOCK);
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("PRAGMA journal_mode = MEMORY");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("COMMIT");
    (options.chmod ?? chmodSync)(file, 0o600);
  } catch (error) {
    try {
      db.close();
    } catch {
      // the lock is dropped with the connection; the error that got here is the one to report
    }
    if (sqliteBusy(error)) throw new ServerLockHeldError(file, { cause: error });
    throw error;
  }
  let held = true;
  return {
    file,
    release() {
      if (!held) return;
      held = false;
      db.close();
    },
  };
}

/** A server that is stopping, by its mark: its process, and when its stop is over at the latest (epoch ms). */
export type Stopping = { pid: number; until: number };

/** Records the data root's server as this process, running: once, as it starts, right after it takes the lock. */
export function markRunning(dataRoot: string): void {
  writeFileSync(join(dataRoot, SERVER_STATE), stateOf(null), { mode: 0o600 });
}

/** Records the data root's server as stopping until `until`, as its close begins: the same file, rewritten in place in one
 *  write of the same length, never made again (a record that is gone is left gone), so the stop adds no entry. */
export function markStopping(dataRoot: string, until: number): void {
  let fd: number;
  try {
    fd = openSync(join(dataRoot, SERVER_STATE), "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    writeSync(fd, stateOf(until), 0, STATE_BYTES, 0);
  } finally {
    closeSync(fd);
  }
}

/** The data root's server, when its record says it is stopping, its process lives and its time is still ahead; none
 *  otherwise (no record, one that can't be read, a server that runs, or one that died as it stopped). */
export function stoppingOf(dataRoot: string, now = Date.now()): Stopping | undefined {
  let mark: unknown;
  try {
    mark = JSON.parse(readFileSync(join(dataRoot, SERVER_STATE), "utf8"));
  } catch {
    return undefined;
  }
  const { pid, until } = (mark ?? {}) as { pid?: unknown; until?: unknown };
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof until !== "number" || !(until > now)) return undefined;
  return processAlive(pid) ? { pid, until } : undefined;
}

/** Takes the data root's server lock, as takeServerLock. When another server holds it and is stopping (its record),
 *  waits for that server as long as its process lives, under one cap, its record's `until` (the server's whole close:
 *  its runs' drain, their carry backs and their boxes' cleanup), retrying every `everyMs`, and tells `waiting` once as it
 *  starts to. A server that is not stopping is refused at once with ServerLockHeldError, as is one that still holds the
 *  lock at its `until`, or a holder that is not the stopping server (its process gone, the lock still held). */
export async function takeServerLockAfterStop(dataRoot: string, options: { waiting?: (stopping: Stopping) => void; everyMs?: number } = {}): Promise<ServerLock> {
  try {
    return takeServerLock(dataRoot);
  } catch (error) {
    if (!(error instanceof ServerLockHeldError)) throw error;
    const stopping = stoppingOf(dataRoot);
    if (!stopping) throw error;
    options.waiting?.(stopping);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, options.everyMs ?? 250));
      try {
        return takeServerLock(dataRoot);
      } catch (again) {
        if (!(again instanceof ServerLockHeldError) || Date.now() >= stopping.until || !processAlive(stopping.pid)) throw again;
      }
    }
  }
}
