// How the server opens a run's database, run.sqlite, which the run's own process writes: in WAL, under an exclusive lock,
// with no automatic checkpoint, and ended by process.exit with no close (pi-durable-disk's exclusive profile, keepWal),
// so its WAL stays until whoever takes the run back checkpoints it. The server never opens it read-write while a
// process holds the run: every read is a fresh read-only open with no locking (`vfs=unix-none`) and an exclusive
// locking mode (the WAL index in heap, no -shm), kept for that read alone, since a connection kept open falls behind
// the WAL; and a read whose last entry is below one already seen for that run is refused, never shown (the monotonic
// guard). The one read-write open is the checkpoint when the server takes the run back (runs.ts), with no process left.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { forgetWalWalk, walHasCommit } from "./workflow/wal.js";
import { profilePragmas } from "@parcha/pi-durable-disk/internals";

/** One open of a run's database, as observeRunDbOpens reports it: `held`, whether a process held the run at the open. */
/** `dropped`: a read of the file alone whose file changed during it, made again (readRunDbSync). */
export type RunDbOpen = { file: string; mode: "read" | "checkpoint" | "dropped"; held: boolean };
const observers = new Set<(open: RunDbOpen) => void>();
/** Tells `observer` of every open of a run's database from here on (tests); the returned call stops it. */
export function observeRunDbOpens(observer: (open: RunDbOpen) => void): () => void {
  observers.add(observer);
  return () => void observers.delete(observer);
}

/** `file` as a SQLite URI path: each segment percent-encoded, so a `?`, `#` or `%` in it is never read as a parameter. */
const uriPath = (file: string): string => file.split("/").map(encodeURIComponent).join("/");

/** What says run database `file` changed: its inode, size and modification time, and its header's file change counter and
 *  page count (bytes 24 to 31). In WAL mode SQLite does not bump the counter at each commit, but a checkpoint writes the
 *  database file, so its time and size move; a reader of the file alone compares this before and after its read. */
function fileMark(file: string): string {
  const at = statSync(file, { bigint: true });
  const header = Buffer.alloc(8);
  const fd = openSync(file, "r");
  try {
    readSync(fd, header, 0, 8, 24);
  } finally {
    closeSync(fd);
  }
  return `${at.ino}:${at.size}:${at.mtimeNs}:${header.toString("hex")}`;
}

/** Tests' seams: `afterPlan`, called between a read's choice of how to open the file and its open; `madeReads`, called
 *  with each MonotonicReads made; `beforeCheckpoint`, called with the take-back's connection just before its close. */
export const runDbTestHooks: { afterPlan?: (file: string) => void; madeReads?: (reads: MonotonicReads) => void; beforeCheckpoint?: (db: DatabaseSync) => void } = {};

/** A read of a run's database file alone whose file changed during it (a run's process wrote and a take-back checkpointed
 *  meanwhile), every try: none of them is shown. */
export class ChangedReadError extends Error {
  constructor(file: string, tries: number) {
    super(`the run's database ${file} changed during each of ${tries} reads`);
  }
}

/** How many times a read whose file changed during it is made again before ChangedReadError. */
const READ_TRIES = 3;

/**
 * One read of run database `file`: `read(db)` on a fresh read-only, lock-free connection, closed after it. A WAL that
 * holds a commit SQLite's recovery takes (walHasCommit): opened with no locking (`vfs=unix-none`), the WAL read too. No
 * WAL, or one with no verified commit yet (a fresh WAL's first transaction, its frames written and no commit): the
 * database file alone, as an immutable file, which is whole then; its read is kept only when the file did not change
 * during it (fileMark), else it is dropped and made again. SQLite's lock-free reader of a WAL with no commit recovers no
 * frame, and its close, a checkpoint with nothing to copy, removes the WAL (sqlite3WalClose) under the writer still
 * writing it, whose commits are then lost; with a commit, that close's checkpoint must write the database file, which
 * this read-only connection cannot, so it fails and removes nothing. Every read and the take-back's checkpoint run in one
 * turn of this process's event loop, and the run's process only appends to its WAL, so the WAL a read opens holds at
 * least the commit its check saw. A read-only close checkpoints nothing it can write. `held`: whether a process holds the
 * run now (reported to observers).
 */
export function readRunDbSync<T>(file: string, held: boolean, read: (db: DatabaseSync) => T): T {
  for (let attempt = 1; ; attempt++) {
    for (const observer of observers) observer({ file, mode: "read", held });
    // A WAL is opened only once it holds a commit SQLite's recovery takes (workflow/wal.ts walHasCommit).
    const immutable = !walHasCommit(`${file}-wal`);
    const before = immutable ? fileMark(file) : undefined;
    runDbTestHooks.afterPlan?.(file);
    const db = new DatabaseSync(immutable ? `file:${uriPath(file)}?mode=ro&immutable=1` : `file:${uriPath(file)}?mode=ro&vfs=unix-none`, { readOnly: true });
    let result: T;
    try {
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      result = read(db);
    } finally {
      db.close();
    }
    if (!immutable || fileMark(file) === before) return result;
    for (const observer of observers) observer({ file, mode: "dropped", held });
    if (attempt >= READ_TRIES) throw new ChangedReadError(file, attempt);
  }
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
  constructor() {
    runDbTestHooks.madeReads?.(this);
  }
  /** How many runs' reads it keeps. */
  get size(): number {
    return this.#seen.size;
  }
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

/** Checkpoints the run database at `file` into its database file and removes its WAL, once no process holds the run
 *  (`held` false; true throws HeldRunDbError before any open). A database with no WAL left is untouched but for the
 *  open. The one read-write open the server makes of a run's database. */
export async function checkpointRunDb(file: string, held: boolean, platform: NodeJS.Platform = process.platform): Promise<void> {
  for (const observer of observers) observer({ file, mode: "checkpoint", held });
  if (held) throw new HeldRunDbError(file);
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    // As its writer opened it (pi-durable-disk's exclusive profile): the WAL index in heap, so no -shm is made; and on
    // macOS F_FULLFSYNC (`fullfsync`, `checkpoint_fullfsync`), as fsync there leaves the drive's cache unflushed. And
    // synchronous FULL whatever level the run's journal runs at, so the checkpoint's copy is synced into the database file
    // before the WAL that held it is removed (pi-durable-disk barriers.ts lists this store as FULL).
    for (const [pragma, value] of Object.entries(profilePragmas("exclusive", platform, "FULL"))) db.exec(`PRAGMA ${pragma} = ${value}`);
    db.prepare("SELECT count(*) FROM sqlite_schema").get();
    runDbTestHooks.beforeCheckpoint?.(db);
  } finally {
    // The close checkpoints: it copies into the database file only pages the WAL holds too, so a lock-free reader still
    // reading the WAL reads the same bytes either way; then it removes the WAL, which a reader that holds it open goes on
    // reading. Never wal_checkpoint(TRUNCATE): that cuts the WAL under such a reader, whose read then fails.
    db.close();
    // The WAL is gone, and with it what was kept of its walk (walHasCommit).
    forgetWalWalk(`${file}-wal`);
  }
}
