// The store's one SQLite connection, on a worker thread (design 2.2): node:sqlite is synchronous, so a commit that waits for
// the disk (a flush at FULL, or a write behind another process's lock) waits here, never on the event loop the runner's
// loops share. WAL with synchronous=NORMAL: a commit is durable against a process crash at once, and against a lost box
// only after the next FULL commit (flush). Every write starts BEGIN IMMEDIATE, so a write never upgrades a read lock and
// deadlocks another writer; busy_timeout covers another process's write in flight.
//
// The messages (connection.ts sends them one at a time, in order):
//   open {file, busyTimeoutMs}            the connection and its pragmas
//   read {sql, params, all}               one statement outside a transaction: its rows (all) or its first row
//   write {statements, full}              one transaction: BEGIN IMMEDIATE, each statement in order, COMMIT; `full` makes it
//                                         a FULL commit (flush). A statement's `expect` checks it changed a row; a miss
//                                         rolls the whole transaction back with its `miss` (fenced, or a final run)
//   begin {full} / step {sql, params} / commit / rollback
//                                         an interactive transaction, for a caller that decides its next statement from
//                                         the last one's rows (the journal's publishing). connection.ts holds every other
//                                         call until it ends.
//   close
import { parentPort } from "node:worker_threads";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Params = readonly SQLInputValue[];
/** What a statement that changes no row means: `fenced` (the claim's epoch is not the run's) or `final` (a final or unknown
 *  run). Carried back with the error so the main thread throws the typed one. */
export type Miss = { kind: "fenced"; runId: string; epoch: number } | { kind: "final"; runId: string };
export type Statement = { sql: string; params?: Params; expect?: Miss };
export type StatementResult = { changes: number; rows: Record<string, unknown>[] };
export type Request =
  | { op: "open"; file: string; busyTimeoutMs: number }
  | { op: "read"; sql: string; params?: Params; all: boolean }
  | { op: "write"; statements: readonly Statement[]; full?: boolean }
  | { op: "begin"; full?: boolean }
  | { op: "step"; statement: Statement }
  | { op: "commit" }
  | { op: "rollback" }
  | { op: "close" };
/** An error as the worker reports it: busy (the lock outlasted busy_timeout), constraint, miss (an expectation), closed,
 *  or sql (anything else). */
export type WorkerError = { kind: "busy" | "constraint" | "sql" | "closed"; message: string } | { kind: "miss"; message: string; miss: Miss };
export type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: WorkerError };

/** A statement's expectation failed: carried out of the transaction, which is rolled back. */
class MissError extends Error {
  readonly miss: Miss;
  constructor(miss: Miss) {
    super(miss.kind === "fenced" ? `run ${miss.runId}: the claim at epoch ${miss.epoch} is no longer the run's` : `run ${miss.runId} is final or unknown`);
    this.miss = miss;
  }
}

let db: DatabaseSync | undefined;
/** The synchronous level a FULL transaction restores at its end. */
const NORMAL = "PRAGMA synchronous = NORMAL";
const FULL = "PRAGMA synchronous = FULL";
let inTx = false;
let txFull = false;

const opened = (): DatabaseSync => {
  if (!db) throw Object.assign(new Error("the store is closed"), { closed: true });
  return db;
};

/** Whether `sql` returns rows (a SELECT, or a write with RETURNING). */
const returnsRows = (sql: string): boolean => /^\s*(?:SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

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

function begin(full: boolean): void {
  const conn = opened();
  if (full) conn.exec(FULL);
  try {
    conn.exec("BEGIN IMMEDIATE");
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
  } finally {
    inTx = false;
    if (txFull) conn.exec(NORMAL);
    txFull = false;
  }
}

function errorOf(error: unknown): WorkerError {
  if (error instanceof MissError) return { kind: "miss", message: error.message, miss: error.miss };
  const e = error as { closed?: boolean; errcode?: number; message?: string };
  const message = String(e?.message ?? error);
  if (e?.closed) return { kind: "closed", message };
  // SQLITE_BUSY (5) and SQLITE_LOCKED (6), with their extended codes in the low byte.
  if (typeof e?.errcode === "number" && ((e.errcode & 0xff) === 5 || (e.errcode & 0xff) === 6)) return { kind: "busy", message };
  // SQLITE_CONSTRAINT (19).
  if (typeof e?.errcode === "number" && (e.errcode & 0xff) === 19) return { kind: "constraint", message };
  return { kind: "sql", message };
}

function handle(request: Request): unknown {
  switch (request.op) {
    case "open": {
      db = new DatabaseSync(request.file);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(NORMAL);
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(request.busyTimeoutMs))}`);
      db.exec("PRAGMA foreign_keys = ON");
      return null;
    }
    case "read": {
      const prepared = opened().prepare(request.sql);
      return request.all ? prepared.all(...(request.params ?? [])) : (prepared.get(...(request.params ?? [])) ?? null);
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
      begin(request.full === true);
      return null;
    case "step":
      try {
        return step(request.statement);
      } catch (error) {
        // A miss or an error inside an interactive transaction ends it: nothing of it is kept.
        if (inTx) end(false);
        throw error;
      }
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
