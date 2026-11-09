// The store's one SQLite connection, on a worker thread (design 2.2): node:sqlite is synchronous, so a commit that waits for
// the disk (a flush at FULL, or a write behind another process's lock) waits here, never on the event loop the runner's
// loops share. WAL with synchronous=NORMAL: a commit is durable against a process crash at once, and against a lost box
// only after the next FULL commit (flush). Every write starts BEGIN IMMEDIATE, so a write never upgrades a read lock and
// deadlocks another writer; busy_timeout covers another process's write in flight. Foreign keys are on.
//
// The messages (connection.ts sends them one at a time, in order):
//   open {file, busyTimeoutMs, owner}     the connection and its pragmas; `owner` also takes the store's owner lock (one
//                                         server per store file): an exclusive lock on `<file>.owner`, held until close,
//                                         let go by the OS when the process dies
//   exec {sql}                            SQL text, maybe several statements, no bindings
//   stmt {statement, mode}                one statement: run, count (its changes), get (first row) or all. Outside a
//                                         transaction, a run or count is its own BEGIN IMMEDIATE transaction
//   write {statements, full}              one transaction: BEGIN IMMEDIATE, each statement in order, COMMIT; `full` makes it
//                                         a FULL commit (flush). A statement's `expect` checks it changed a row; a miss
//                                         rolls the whole transaction back with its `miss` (fenced, or a final run)
//   begin {full} / commit / rollback      an interactive transaction (connection.ts transaction()), its statements sent
//                                         as stmt, or as step (one statement, its changes and rows, its `expect` checked)
//                                         in between
//   close
import { parentPort } from "node:worker_threads";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { inMemory } from "./memory.js";

export type Params = readonly SQLInputValue[];
/** What a statement that changes no row means: `fenced` (the claim's epoch is not the run's) or `final` (a final or unknown
 *  run). Carried back with the error so the main thread throws the typed one. */
export type Miss = { kind: "fenced"; runId: string; epoch: number } | { kind: "final"; runId: string };
export type Statement = { sql: string; params?: Params; expect?: Miss };
export type StatementResult = { changes: number; rows: Record<string, unknown>[] };
export type Mode = "run" | "count" | "get" | "all";
export type Request =
  | { op: "open"; file: string; busyTimeoutMs: number; owner: boolean }
  | { op: "exec"; sql: string }
  | { op: "stmt"; statement: Statement; mode: Mode }
  | { op: "write"; statements: readonly Statement[]; full?: boolean }
  | { op: "begin"; full?: boolean; read?: boolean }
  | { op: "step"; statement: Statement }
  | { op: "commit" }
  | { op: "rollback" }
  | { op: "close" };
/** An error as the worker reports it: busy (the lock outlasted busy_timeout), constraint, miss (an expectation), owned
 *  (another server holds the store), closed, or sql (anything else). */
export type WorkerError =
  | { kind: "busy" | "sql" | "closed" | "owned"; message: string }
  /** `errcode`: SQLite's extended result code, which names the rule (CHECK, UNIQUE, PRIMARYKEY, FOREIGNKEY, NOTNULL). */
  | { kind: "constraint"; message: string; errcode: number }
  | { kind: "miss"; message: string; miss: Miss };
export type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: WorkerError };

/** A statement's expectation failed: carried out of the transaction, which is rolled back. */
class MissError extends Error {
  readonly miss: Miss;
  constructor(miss: Miss) {
    super(miss.kind === "fenced" ? `run ${miss.runId}: the claim at epoch ${miss.epoch} is no longer the run's` : `run ${miss.runId} is final or unknown`);
    this.miss = miss;
  }
}
class OwnedError extends Error {}
class ClosedError extends Error {}

let db: DatabaseSync | undefined;
let owner: DatabaseSync | undefined;
const NORMAL = "PRAGMA synchronous = NORMAL";
const FULL = "PRAGMA synchronous = FULL";
let inTx = false;
let txFull = false;

const opened = (): DatabaseSync => {
  if (!db) throw new ClosedError("the store is closed");
  return db;
};

/** Whether `sql` returns rows (a SELECT, or a write with RETURNING). */
const returnsRows = (sql: string): boolean => /^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

function step(statement: Statement): StatementResult {
  const prepared = opened().prepare(statement.sql);
  const params = statement.params ?? [];
  let result: StatementResult;
  if (returnsRows(statement.sql)) {
    const rows = prepared.all(...params) as Record<string, unknown>[];
    result = { changes: rows.length, rows };
  } else {
    const run = prepared.run(...params);
    result = { changes: Number(run.changes), rows: [] };
  }
  if (statement.expect && result.changes === 0) throw new MissError(statement.expect);
  return result;
}

/** A transaction: BEGIN IMMEDIATE for a write; for `read`, a deferred one that takes no writer lock (one snapshot). */
function begin(full: boolean, read = false): void {
  const conn = opened();
  if (full) conn.exec(FULL);
  try {
    conn.exec(read ? "BEGIN DEFERRED" : "BEGIN IMMEDIATE");
  } catch (error) {
    if (full) conn.exec(NORMAL);
    throw error;
  }
  inTx = true;
  txFull = full;
}

function end(commit: boolean): void {
  const conn = opened();
  try {
    conn.exec(commit ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    // A COMMIT that fails (a deferred foreign key, a full disk) leaves the transaction open in SQLite: roll it back
    // before clearing the state, or the next BEGIN IMMEDIATE fails, a transaction within a transaction, for good.
    if (commit) {
      try {
        conn.exec("ROLLBACK");
      } catch {
        // No transaction left open: SQLite already ended it.
      }
    }
    throw error;
  } finally {
    inTx = false;
    if (txFull) conn.exec(NORMAL);
    txFull = false;
  }
}

/** `work` inside its own BEGIN IMMEDIATE transaction when none is open; inside the open one otherwise. */
function written<T>(work: () => T): T {
  if (inTx) return work();
  begin(false);
  try {
    const value = work();
    end(true);
    return value;
  } catch (error) {
    if (inTx) end(false);
    throw error;
  }
}

function errorOf(error: unknown): WorkerError {
  if (error instanceof MissError) return { kind: "miss", message: error.message, miss: error.miss };
  if (error instanceof OwnedError) return { kind: "owned", message: error.message };
  if (error instanceof ClosedError) return { kind: "closed", message: error.message };
  const e = error as { errcode?: number; message?: string };
  const message = String(e?.message ?? error);
  // SQLITE_BUSY (5) and SQLITE_LOCKED (6), with their extended codes in the high bytes.
  if (typeof e?.errcode === "number" && ((e.errcode & 0xff) === 5 || (e.errcode & 0xff) === 6)) return { kind: "busy", message };
  // SQLITE_CONSTRAINT (19).
  if (typeof e?.errcode === "number" && (e.errcode & 0xff) === 19) return { kind: "constraint", message, errcode: e.errcode };
  return { kind: "sql", message };
}

/** The store's owner lock: an exclusive lock on `<file>.owner` that a second owner cannot take. An in-memory database is
 *  this connection's own data, which no other server can open: it takes none (a lock file would be left in the working
 *  directory, named after no file). */
function takeOwnerLock(file: string): void {
  if (inMemory(file)) return;
  const lock = new DatabaseSync(`${file}.owner`);
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec("PRAGMA locking_mode = EXCLUSIVE");
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    const e = error as { errcode?: number };
    if (typeof e?.errcode === "number" && ((e.errcode & 0xff) === 5 || (e.errcode & 0xff) === 6)) throw new OwnedError(`another server holds the store at ${file}`);
    throw error;
  }
  owner = lock;
}

function handle(request: Request): unknown {
  switch (request.op) {
    case "open": {
      if (request.owner) takeOwnerLock(request.file);
      db = new DatabaseSync(request.file);
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(request.busyTimeoutMs))}`);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(NORMAL);
      db.exec("PRAGMA foreign_keys = ON");
      return null;
    }
    case "exec":
      opened().exec(request.sql);
      return null;
    case "stmt": {
      const { statement, mode } = request;
      if (mode === "get" || mode === "all") {
        const prepared = opened().prepare(statement.sql);
        return mode === "all" ? prepared.all(...(statement.params ?? [])) : (prepared.get(...(statement.params ?? [])) ?? null);
      }
      return written(() => step(statement).changes);
    }
    case "write": {
      begin(request.full === true);
      try {
        const results = request.statements.map(step);
        end(true);
        return results;
      } catch (error) {
        if (inTx) end(false);
        throw error;
      }
    }
    case "begin":
      begin(request.full === true, request.read === true);
      return null;
    case "step":
      if (!inTx) throw new Error("a step outside a transaction");
      return step(request.statement);
    case "commit":
      end(true);
      return null;
    case "rollback":
      if (inTx) end(false);
      return null;
    case "close": {
      if (inTx) end(false);
      db?.close();
      db = undefined;
      owner?.close();
      owner = undefined;
      return null;
    }
  }
}

parentPort!.on("message", ({ id, request }: { id: number; request: Request }) => {
  let reply: Reply;
  try {
    reply = { id, ok: true, value: handle(request) };
  } catch (error) {
    reply = { id, ok: false, error: errorOf(error) };
  }
  parentPort!.postMessage(reply);
});
