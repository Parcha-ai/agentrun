// How the server opens a run's database, run.sqlite, which the run's own process writes: in WAL, under an exclusive lock,
// with no automatic checkpoint, and ended by process.exit with no close (pi-durable-disk's exclusive profile, keepWal),
// so its WAL stays until whoever takes the run back checkpoints it. The server never opens it read-write while a
// process holds the run: every read is a fresh read-only open with no locking (`vfs=unix-none`) and an exclusive
// locking mode (the WAL index in heap, no -shm), kept for that read alone, since a connection kept open falls behind
// the WAL; and a read whose last entry is below one already seen for that run is refused, never shown (the monotonic
// guard). The one read-write open is the checkpoint when the server takes the run back (runs.ts), with no process left.
import { DatabaseSync } from "node:sqlite";

/** One open of a run's database, as observeRunDbOpens reports it: `held`, whether a process held the run at the open. */
export type RunDbOpen = { file: string; mode: "read" | "checkpoint"; held: boolean };
const observers = new Set<(open: RunDbOpen) => void>();
/** Tells `observer` of every open of a run's database from here on (tests); the returned call stops it. */
export function observeRunDbOpens(observer: (open: RunDbOpen) => void): () => void {
  observers.add(observer);
  return () => void observers.delete(observer);
}

/** `file` as a SQLite URI path: each segment percent-encoded, so a `?`, `#` or `%` in it is never read as a parameter. */
const uriPath = (file: string): string => file.split("/").map(encodeURIComponent).join("/");

/** A fresh read-only, lock-free connection to the run database at `file`, for one read: `read(db)`, then closed. A
 *  read-only close checkpoints nothing. `held`: whether a process holds the run now (reported to observers). */
export async function readRunDb<T>(file: string, held: boolean, read: (db: DatabaseSync) => T): Promise<T> {
  const db = openRunReader(file, held);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** A fresh read-only, lock-free connection to the run database at `file` (as readRunDb's), for a synchronous reader that
 *  closes it itself: `held` as readRunDb's. */
export function openRunReader(file: string, held = false): DatabaseSync {
  for (const observer of observers) observer({ file, mode: "read", held });
  const db = new DatabaseSync(`file:${uriPath(file)}?mode=ro&vfs=unix-none`, { readOnly: true });
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** A read of a run's database whose last entry is below one already seen for that run: an older view of the file, which a
 *  read must never show (the monotonic guard). The caller keeps what it read before. */
export class BehindReadError extends Error {
  constructor(readonly seen: number, readonly read: number) {
    super(`the run's database read ends at entry ${read}, behind entry ${seen} read before`);
  }
}

/** The highest entry id each run's reads have seen: a read below it is refused (BehindReadError). */
export class MonotonicReads {
  readonly #seen = new Map<string, number>();
  /** Accepts run `runId`'s read that ends at entry `last` (0 for none), or throws BehindReadError. */
  accept(runId: string, last: number): void {
    const seen = this.#seen.get(runId) ?? 0;
    if (last < seen) throw new BehindReadError(seen, last);
    this.#seen.set(runId, last);
  }
  /** Forgets run `runId`'s reads: a run that is gone, or whose store was replaced. */
  forget(runId: string): void {
    this.#seen.delete(runId);
  }
}

/** A read-write open of a run's database while a process holds the run: refused, never made. */
export class HeldRunDbError extends Error {
  constructor(file: string) {
    super(`the server never opens a run's database read-write while a process holds the run (${file})`);
  }
}

/** Checkpoints the run database at `file` into its database file and empties its WAL, once no process holds the run
 *  (`held` false; true throws HeldRunDbError before any open). A database with no WAL left is untouched but for the
 *  open. The one read-write open the server makes of a run's database. */
export async function checkpointRunDb(file: string, held: boolean): Promise<void> {
  for (const observer of observers) observer({ file, mode: "checkpoint", held });
  if (held) throw new HeldRunDbError(file);
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    // As its writer opened it: the WAL index in heap, so no -shm is made.
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
