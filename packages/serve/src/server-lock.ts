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
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteBusy } from "./agents.js";

export const SERVER_LOCK = "server.lock";

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
