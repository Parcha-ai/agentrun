// The store: pi's SqliteStorage over one database file in one of two profiles, behind a fence-aware facade.
// Both profiles run at synchronous = FULL with mmap off, and every pragma is read back before the store opens. After a
// storage error of the I/O, full or not-a-database class the handle is fenced: nothing is retried on it, nothing read
// from it is trusted, and every later call fails at once with StoreFencedError. The facade is the only place the
// package reads a storage error.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeSqliteDatabase, openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FencedError, HeldError } from "./errors.ts";

/** `exclusive`: no `-shm`, one connection. `shared`: WAL with `-shm`, readers on the same mount may connect. */
export type Profile = "exclusive" | "shared";

// SQLite primary result codes; an extended code carries its primary code in the low byte.
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;
const SQLITE_NOTADB = 26;

const FENCING_CODES: ReadonlySet<number> = new Set([SQLITE_IOERR, SQLITE_FULL, SQLITE_NOTADB]);
const BUSY_CODES: ReadonlySet<number> = new Set([SQLITE_BUSY, SQLITE_LOCKED]);

const primary = (errcode: number): number => errcode & 0xff;

/** Every node:sqlite extended result code in an error, its causes and its aggregate members, outermost first. */
function resultCodes(error: unknown, seen: Set<unknown> = new Set()): number[] {
  if (typeof error !== "object" || error === null || seen.has(error)) return [];
  seen.add(error);
  const codes: number[] = [];
  const { errcode, cause } = error as { errcode?: unknown; cause?: unknown };
  if (typeof errcode === "number") codes.push(errcode);
  const members = error instanceof AggregateError ? error.errors : [];
  for (const inner of [...members, cause]) codes.push(...resultCodes(inner, seen));
  return codes;
}

/** Thrown by every call on a fenced handle. `cause` is the storage error that fenced it, `errcode` its SQLite code. */
export class StoreFencedError extends FencedError {
  readonly errcode: number;
  constructor(cause: unknown, errcode: number) {
    super(`store fenced by SQLite result code ${errcode}; the handle is unusable`, { cause, code: "STORE_FENCED" });
    this.errcode = errcode;
  }
}

/** Thrown when another connection holds the database file at open (the exclusive profile's "database is locked"). */
export class StoreBusyError extends HeldError {
  constructor(file: string, profile: Profile, cause: unknown) {
    super("store", `store ${file} is held by another connection (${profile} profile)`, { cause });
  }
}

export type PragmaMismatch = { readonly pragma: string; readonly expected: string | number; readonly actual: unknown };

/** Thrown when the filesystem or SQLite did not accept the profile's pragmas; the store is never opened. */
export class StorePragmaError extends Error {
  readonly code = "STORE_PRAGMA";
  readonly profile: Profile;
  readonly mismatches: readonly PragmaMismatch[];
  constructor(profile: Profile, mismatches: readonly PragmaMismatch[]) {
    const detail = mismatches.map((m) => `${m.pragma} is ${JSON.stringify(m.actual)}, expected ${JSON.stringify(m.expected)}`);
    super(`${profile} profile not accepted: ${detail.join("; ")}`);
    this.name = "StorePragmaError";
    this.profile = profile;
    this.mismatches = mismatches;
  }
}

/** What each profile must read back after it is set. `synchronous` 2 is FULL. */
export const PROFILE_PRAGMAS = {
  exclusive: { locking_mode: "exclusive", journal_mode: "wal", synchronous: 2, mmap_size: 0 },
  shared: { locking_mode: "normal", journal_mode: "wal", synchronous: 2, mmap_size: 0 },
} as const satisfies Record<Profile, Record<string, string | number>>;

/** Read every pragma of `profile` back and refuse (StorePragmaError) when any differs. */
export async function assertPragmas(database: SqliteExecutor, profile: Profile): Promise<void> {
  const mismatches: PragmaMismatch[] = [];
  for (const [pragma, expected] of Object.entries(PROFILE_PRAGMAS[profile])) {
    const row = await database.get<Record<string, SqliteValue>>(`PRAGMA ${pragma}`);
    const actual = row === undefined ? undefined : Object.values(row)[0];
    if (actual !== expected) mismatches.push({ pragma, expected, actual });
  }
  if (mismatches.length > 0) throw new StorePragmaError(profile, mismatches);
}

/**
 * The fenced state of one handle. The first error whose result code is in the I/O, full or not-a-database class marks it
 * fenced, runs `onFenced` once (before the error propagates), and from then on every operation fails with the same
 * StoreFencedError: operations still in flight when it was marked fail too, and their results are discarded.
 */
export class Fence {
  #error: StoreFencedError | undefined;
  readonly #onFenced: ((error: StoreFencedError) => void) | undefined;

  constructor(onFenced?: (error: StoreFencedError) => void) {
    this.#onFenced = onFenced;
  }

  get fenced(): boolean {
    return this.#error !== undefined;
  }

  /** The error that fenced the handle, once it is fenced. */
  get error(): StoreFencedError | undefined {
    return this.#error;
  }

  assertLive(): void {
    if (this.#error !== undefined) throw this.#error;
  }

  /** Run one storage operation under the fence. */
  async guard<T>(operation: () => Promise<T> | T): Promise<T> {
    this.assertLive();
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      throw this.#absorb(error);
    }
    this.assertLive();
    return result;
  }

  #absorb(error: unknown): unknown {
    if (this.#error !== undefined) return this.#error;
    const errcode = resultCodes(error).find((code) => FENCING_CODES.has(primary(code)));
    if (errcode === undefined) return error;
    const fenced = new StoreFencedError(error, errcode);
    this.#error = fenced;
    try {
      this.#onFenced?.(fenced);
    } catch (listenerError) {
      // A throwing listener must neither hide the fence nor be swallowed: it surfaces as an uncaught exception.
      queueMicrotask(() => {
        throw listenerError;
      });
    }
    return fenced;
  }
}

class FencedExecutor implements SqliteExecutor {
  protected readonly fence: Fence;
  readonly #inner: SqliteExecutor;

  constructor(fence: Fence, inner: SqliteExecutor) {
    this.fence = fence;
    this.#inner = inner;
  }

  exec(sql: string): Promise<void> {
    return this.fence.guard(() => this.#inner.exec(sql));
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.fence.guard(() => this.#inner.run(sql, ...params));
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.fence.guard(() => this.#inner.get<T>(sql, ...params));
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.fence.guard(() => this.#inner.all<T>(sql, ...params));
  }
}

/**
 * pi's `SqliteDatabase` facade with the fence applied by delegation: statements, the transaction handle's statements
 * and the commit itself all report to the same `Fence`. A fenced handle is abandoned, not closed: `close()` fails at
 * once without touching the database, because closing runs a checkpoint and a fenced mount may never answer. The
 * process is expected to exit.
 */
export class FencedDatabase extends FencedExecutor implements SqliteDatabase {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase, fence: Fence = new Fence()) {
    super(fence, database);
    this.#database = database;
  }

  get fenced(): boolean {
    return this.fence.fenced;
  }

  get fencedBy(): StoreFencedError | undefined {
    return this.fence.error;
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.fence.guard(() =>
      this.#database.transaction((handle) => callback(new FencedExecutor(this.fence, handle))),
    );
  }

  close(): Promise<void> {
    return this.fence.guard(() => this.#database.close());
  }
}

export type OpenOptions = {
  /** Runs once, synchronously, when the handle is fenced and before the failing call rejects. */
  readonly onFenced?: (error: StoreFencedError) => void;
  /** Wraps the raw database inside the fence, for instrumentation and fault injection. */
  readonly decorate?: (database: SqliteDatabase) => SqliteDatabase;
};

export type ArchilStore = {
  readonly storage: SqliteStorage;
  /** The fence-aware facade the storage runs on: `database.fenced`, `database.fencedBy`. */
  readonly database: FencedDatabase;
  readonly profile: Profile;
  readonly file: string;
};

/**
 * Open `file` as a pi-durable store in `profile` (default `exclusive`). The exclusive profile sets
 * `locking_mode = EXCLUSIVE` before `journal_mode = WAL`, so the WAL index lives in heap and no `-shm` file exists; a
 * second connection gets "database is locked". The shared profile is pi's own WAL opener, with `-shm`. Rejects with
 * StorePragmaError when a pragma does not read back, StoreBusyError when another connection holds the file, and
 * StoreFencedError when the storage is already fenced at open (that handle is abandoned, as in FencedDatabase).
 */
export async function openArchilStore(
  file: string,
  profile: Profile = "exclusive",
  options: OpenOptions = {},
): Promise<ArchilStore> {
  if (profile !== "exclusive" && profile !== "shared") throw new TypeError(`unknown store profile ${JSON.stringify(profile)}`);
  const fence = new Fence(options.onFenced);
  const decorate = options.decorate ?? ((database: SqliteDatabase) => database);
  let database: FencedDatabase | undefined;
  try {
    if (file !== ":memory:") await mkdir(dirname(file), { recursive: true });
    if (profile === "exclusive") {
      const raw = await fence.guard(() => new NodeSqliteDatabase(new DatabaseSync(file, { timeout: 0 })));
      database = new FencedDatabase(decorate(raw), fence);
      await database.exec("PRAGMA locking_mode = EXCLUSIVE"); // before WAL: the WAL index stays in heap
      await database.exec("PRAGMA journal_mode = WAL");
    } else {
      database = new FencedDatabase(decorate(await fence.guard(() => openNodeSqliteDatabase(file))), fence);
    }
    await database.exec("PRAGMA synchronous = FULL"); // fsync the WAL on every commit
    await database.exec("PRAGMA mmap_size = 0"); // no mmap I/O of the database file on a network filesystem
    await assertPragmas(database, profile);
    const storage = await SqliteStorage.open(database);
    return { storage, database, profile, file };
  } catch (error) {
    if (database !== undefined && !fence.fenced) await database.close().catch(() => undefined);
    if (resultCodes(error).some((code) => BUSY_CODES.has(primary(code)))) throw new StoreBusyError(file, profile, error);
    throw error;
  }
}
