// The store tests' connection until the store's own worker connection lands (store/sqlite/connection.ts): one
// node:sqlite connection in this process, behind the same interface (Chord's SqliteDatabase: exec, run, runCounted,
// get, all, transaction, close), every write transaction a BEGIN IMMEDIATE, transactions queued one at a time. A
// minimal runs table stands in for the store's schema (store/schema.ts) where a test needs a run row to fence.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A connection to a fresh store file in a scratch directory of test `t`, closed and removed after it. */
export function scratchConnection(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-store-"));
  const connection = openConnection(join(dir, "store.sqlite"));
  t.after(async () => {
    await connection.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  return connection;
}

/** A SqliteDatabase over one node:sqlite connection to `file` (WAL, synchronous NORMAL). */
export function openConnection(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
  const statements = new Map();
  const prepared = (sql) => {
    let statement = statements.get(sql);
    if (!statement) statements.set(sql, (statement = db.prepare(sql)));
    return statement;
  };
  const executor = {
    exec: async (sql) => void db.exec(sql),
    run: async (sql, ...params) => void prepared(sql).run(...params),
    runCounted: async (sql, ...params) => Number(prepared(sql).run(...params).changes),
    get: async (sql, ...params) => prepared(sql).get(...params),
    all: async (sql, ...params) => prepared(sql).all(...params),
  };
  let queue = Promise.resolve();
  let closed = false;
  const queued = (work) => {
    const next = queue.then(() => {
      if (closed) throw new Error("the store connection is closed");
      return work();
    });
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    exec: (sql) => queued(() => executor.exec(sql)),
    run: (sql, ...params) => queued(() => executor.run(sql, ...params)),
    runCounted: (sql, ...params) => queued(() => executor.runCounted(sql, ...params)),
    get: (sql, ...params) => queued(() => executor.get(sql, ...params)),
    all: (sql, ...params) => queued(() => executor.all(sql, ...params)),
    transaction: (callback) => queued(async () => {
      db.exec("BEGIN IMMEDIATE");
      let result;
      try {
        result = await callback(executor);
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch (rollback) {
          throw new AggregateError([error, rollback], "the transaction failed and its rollback failed");
        }
        throw error;
      }
      db.exec("COMMIT");
      return result;
    }),
    close: () => queued(async () => {
      closed = true;
      db.close();
    }),
  };
}

/** The store's runs table as far as the journal needs it (store/schema.ts owns the real one). */
export const RUNS_DDL = `CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'queued',
  epoch INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  metrics TEXT,
  summary TEXT,
  ended_at TEXT
)`;

/** An outbox table for staged rows of run moments (tl-triggers' outbox, as far as these tests need it). */
export const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  moment TEXT NOT NULL,
  body TEXT
)`;

/** The store's commands table as far as the journal needs it (store/schema.ts owns the real one). */
export const COMMANDS_DDL = `CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT,
  created_at TEXT,
  taken_at TEXT
)`;

/** A run row `id` claimed at `epoch` (state running). */
export async function runRow(connection, id, epoch = 1) {
  await connection.exec(RUNS_DDL);
  await connection.run("INSERT INTO runs (id, state, epoch) VALUES (?, 'running', ?)", id, epoch);
  return { runId: id, epoch };
}
