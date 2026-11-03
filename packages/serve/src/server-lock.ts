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
// and a second. It says so in <data>/server.stopping (its pid, and when its stop is over at the latest), written as its
// close begins and removed as it ends. A start that finds the lock held reads that file only then, and waits for a server
// that is stopping instead of refusing it; a mark whose pid is gone or whose time has passed is no stop.
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { sqliteBusy } from "./agents.js";

export const SERVER_LOCK = "server.lock";
/** The mark of a server that is stopping: `{ pid, until }`, `until` in epoch ms. */
export const SERVER_STOPPING = "server.stopping";

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

/** Marks the data root's server as stopping until `until`, as its close begins; the function returned removes the mark.
 *  Written whole beside its name, then renamed over it, so a reader never sees half of one. */
export function markStopping(dataRoot: string, until: number): () => void {
  const file = join(dataRoot, SERVER_STOPPING);
  const temp = `${file}.${process.pid}`;
  writeFileSync(temp, JSON.stringify({ pid: process.pid, until }), { mode: 0o600 });
  renameSync(temp, file);
  return () => rmSync(file, { force: true });
}

/** The data root's stopping mark, when its process lives and its time is still ahead; none otherwise (no mark, one that
 *  can't be read, or one a server left that died as it stopped). */
export function stoppingOf(dataRoot: string, now = Date.now()): Stopping | undefined {
  let mark: unknown;
  try {
    mark = JSON.parse(readFileSync(join(dataRoot, SERVER_STOPPING), "utf8"));
  } catch {
    return undefined;
  }
  const { pid, until } = (mark ?? {}) as { pid?: unknown; until?: unknown };
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof until !== "number" || !(until > now)) return undefined;
  return processAlive(pid) ? { pid, until } : undefined;
}

/** Takes the data root's server lock, as takeServerLock. When another server holds it and is stopping (its mark), waits
 *  for that server, up to its mark's `until`, retrying every `everyMs`, and tells `waiting` once as it starts to. A
 *  server that is not stopping is refused at once with ServerLockHeldError, as is one that still holds the lock at its
 *  `until`. */
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
        if (!(again instanceof ServerLockHeldError) || Date.now() >= stopping.until) throw again;
      }
    }
  }
}
