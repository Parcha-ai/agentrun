// The main thread's side of the store's one connection (worker.ts). It is a Chord SqliteDatabase
// (@earendil-works/chord/sqlite: exec, run, runCounted, get, all, transaction, close), the shape pi's SqliteStorage takes,
// so the journal (store/journal) runs on it as written. Every call is a message to the worker, answered in order, on one
// queue: a call starts when the one before it has answered, and a transaction holds every other call until it commits or
// rolls back. Errors come back typed: Fenced, RunFinal, StoreBusy, StoreConstraint, StoreClosed, StoreOwned.
import { realpathSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { type Dialect, SQLITE } from "../dialect.js";
import { inMemory } from "./memory.js";
import { Fenced, RunFinal, StoreBusy, StoreClosed, StoreConstraint, StoreDeadline, StoreOwned, StoreWorkerLost } from "../store.js";
import type { Mode, Params, Reply, Request, Statement, StatementResult, WorkerError } from "./worker.js";

export type { Params, Statement, StatementResult } from "./worker.js";

/** How long a transaction may stay open (it holds every other call of the process) before it is rolled back. */
export const DEFAULT_TRANSACTION_DEADLINE_MS = 10_000;

/** A value SQLite takes or gives back (Chord's SqliteValue). */
export type SqliteValue = null | number | bigint | string | Uint8Array;
/** Chord's SqliteExecutor: what a database and a transaction handle both do. */
export interface SqliteExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqliteValue[]): Promise<void>;
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number>;
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
}
/** Chord's SqliteDatabase. */
export interface SqliteDatabase extends SqliteExecutor {
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
/** A transaction's handle: Chord's executor, and step() for one statement with its result (changes and rows), whose
 *  `expect` (a fence, a final run) rolls the transaction back when it changes no row. */
export interface Tx extends SqliteExecutor {
  step(statement: Statement): Promise<StatementResult>;
  /** What this database's SQL says differently, and its locks (store/dialect.ts). */
  readonly dialect: Dialect;
}

/** A transaction's options: `full`, a durable commit (as flush); `read`, one snapshot that only reads; `deadlineMs`, how
 *  long it may stay open before it is rolled back (StoreDeadline). */
export interface TransactionOptions {
  readonly full?: boolean;
  readonly read?: boolean;
  readonly deadlineMs?: number;
}

/** The store's connection as its shared domain code (store.ts here, run-patch.ts, journal/storage.ts) uses it, whichever
 *  database is under it: this file's Connection on SQLite, postgres/connection.ts on Postgres. Statements take `?`
 *  parameters; a statement's `expect` (a fence, a final run) rolls its transaction back when it changes no row. */
export interface StoreConnection {
  readonly dialect: Dialect;
  /** Where this connection's data is (Store.where): an identity two connections to the same data share and two to
   *  different data never do. SQLite: "sqlite:" and the database file's real path, or "sqlite:memory:<n>" for each
   *  in-memory database. A database server's: its kind, host, database and schema, never a user, a password or any
   *  credential. An in-process key only: never printed in a log line, an error or an answer. */
  readonly where: string;
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
  /** One write transaction of fixed statements, in order; `full`: a durable commit. */
  write(statements: readonly Statement[], options?: { full?: boolean }): Promise<StatementResult[]>;
  /** A transaction the callback steps through its handle; it commits when the callback resolves, rolls back when it
   *  rejects. */
  transaction<T>(callback: (transaction: Tx) => Promise<T>, options?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
}

function typed(error: WorkerError): Error {
  switch (error.kind) {
    case "miss":
      return error.miss.kind === "fenced" ? new Fenced(error.miss.runId, error.miss.epoch) : new RunFinal(error.miss.runId);
    case "busy":
      return new StoreBusy(`the store stayed locked past its busy wait: ${error.message}`);
    case "constraint":
      return new StoreConstraint(error.message);
    case "closed":
      return new StoreClosed();
    case "owned":
      return new StoreOwned(error.message);
    default:
      return new Error(`the store's SQLite: ${error.message}`);
  }
}

/** In-memory databases opened in this process: each is its own data, so each gets its own `where`. */
let memoryDatabases = 0;

/** A SQLite database's identity (StoreConnection.where): its file's real path, so two connections to one file (two roles,
 *  a path given two ways) share it; an in-memory database is its own data, never another's. */
function whereOf(file: string): string {
  if (inMemory(file)) return `sqlite:memory:${++memoryDatabases}`;
  return `sqlite:${realpathSync(file)}`;
}

export class Connection implements SqliteDatabase, StoreConnection {
  readonly dialect: Dialect = SQLITE;
  #where = "";
  get where(): string {
    return this.#where;
  }
  readonly #worker: Worker;
  #next = 1;
  readonly #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** The tail of the queue: each call chains on it. */
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  /** Set when the store itself ends the worker (close), so its exit is no loss. */
  #closing = false;
  /** The worker's failure or exit: every call after it is refused with it. */
  #lost: StoreWorkerLost | undefined;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.on("message", (reply: Reply) => {
      const waiter = this.#waiting.get(reply.id);
      if (!waiter) return;
      this.#waiting.delete(reply.id);
      if (this.#waiting.size === 0) worker.unref();
      if (reply.ok) waiter.resolve(reply.value);
      else waiter.reject(typed(reply.error));
    });
    // A worker that fails or exits answers nothing more: every call waiting is refused, and so is every call after it,
    // never posted to a dead worker to wait forever.
    const lost = (why: string) => {
      if (this.#lost || this.#closing) return;
      this.#lost = new StoreWorkerLost(why);
      for (const waiter of this.#waiting.values()) waiter.reject(this.#lost);
      this.#waiting.clear();
    };
    worker.on("error", (error) => lost(`failed: ${error.message}`));
    worker.on("exit", (code) => lost(`exited (code ${code})`));
    // An idle worker never holds the process open by itself (the runner's own work does); a call waiting for its answer
    // does, so a process whose only work is the store's does not end with that work in flight.
    worker.unref();
  }

  /** The worker thread under `connection`: for tests that play a worker crash. */
  static workerOf(connection: Connection): Worker {
    return connection.#worker;
  }

  /** Starts the worker and opens `file` in it; `owner` takes the store's owner lock too (StoreOwned when another holds it). */
  static async open(file: string, { busyTimeoutMs = 10_000, owner = false }: { busyTimeoutMs?: number; owner?: boolean } = {}): Promise<Connection> {
    const worker = new Worker(new URL("./worker.js", import.meta.url));
    const connection = new Connection(worker);
    try {
      await connection.#send({ op: "open", file, busyTimeoutMs, owner });
      // Opened, the file exists: its real path names it.
      connection.#where = whereOf(file);
    } catch (error) {
      await worker.terminate();
      throw error;
    }
    return connection;
  }

  /** A message straight to the worker, outside the queue: only the queue's own steps call it. */
  #send(request: Request): Promise<unknown> {
    if (this.#lost) return Promise.reject(this.#lost);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      this.#worker.ref();
      this.#worker.postMessage({ id, request });
    });
  }

  /** Runs `work` when every call queued before it has answered. */
  #queued<T>(work: () => Promise<T>): Promise<T> {
    if (this.#lost) return Promise.reject(this.#lost);
    if (this.#closed) return Promise.reject(new StoreClosed());
    const run = this.#tail.then(work, work);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  #stmt(sql: string, params: readonly SqliteValue[], mode: Mode): Promise<unknown> {
    return this.#send({ op: "stmt", statement: { sql, params: params as Params }, mode });
  }

  /** The executor that sends straight to the worker: a transaction's handle, valid while `live()` says so. */
  #executor(live: () => boolean): Tx {
    const check = () => {
      if (!live()) throw new Error("the store's transaction is over: its handle takes no more statements");
    };
    return {
      dialect: this.dialect,
      step: async (statement) => (check(), (await this.#send({ op: "step", statement })) as StatementResult),
      exec: async (sql) => (check(), void (await this.#send({ op: "exec", sql }))),
      run: async (sql, ...params) => (check(), void (await this.#stmt(sql, params, "run"))),
      runCounted: async (sql, ...params) => (check(), (await this.#stmt(sql, params, "count")) as number),
      get: async <T extends object>(sql: string, ...params: SqliteValue[]) => (check(), ((await this.#stmt(sql, params, "get")) ?? undefined) as T | undefined),
      all: async <T extends object>(sql: string, ...params: SqliteValue[]) => (check(), (await this.#stmt(sql, params, "all")) as T[]),
    };
  }

  exec(sql: string): Promise<void> {
    return this.#queued(async () => void (await this.#send({ op: "exec", sql })));
  }
  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.#queued(async () => void (await this.#stmt(sql, params, "run")));
  }
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return this.#queued(async () => (await this.#stmt(sql, params, "count")) as number);
  }
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.#queued(async () => ((await this.#stmt(sql, params, "get")) ?? undefined) as T | undefined);
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#queued(async () => (await this.#stmt(sql, params, "all")) as T[]);
  }

  /** One write transaction of fixed statements: in order; an expectation miss or an error rolls all of them back. `full`: a
   *  FULL commit, durable against a lost box together with every commit before it. */
  write(statements: readonly Statement[], { full = false }: { full?: boolean } = {}): Promise<StatementResult[]> {
    return this.#queued(async () => (await this.#send({ op: "write", statements, full })) as StatementResult[]);
  }

  /** A write transaction (BEGIN IMMEDIATE) the callback steps through its handle, deciding each statement from the ones
   *  before it. It commits when the callback resolves; when the callback rejects it rolls back and rejects with the same
   *  error, or with an AggregateError when the rollback fails too (StoreWorkerLost alone when the worker was lost). `full`: a FULL commit. Every other call of this process
   *  waits for it, so the callback awaits nothing but its own statements (no model or tool call inside), and a transaction
   *  still open `deadlineMs` after it began is rolled back and rejects with StoreDeadline: a later statement of its callback
   *  is refused, and the calls behind it go on. */
  transaction<T>(callback: (transaction: Tx) => Promise<T>, { full = false, read = false, deadlineMs = DEFAULT_TRANSACTION_DEADLINE_MS }: TransactionOptions = {}): Promise<T> {
    // `read`: one snapshot in a deferred transaction, taking no writer lock (its statements only read).
    return this.#queued(async () => {
      await this.#send({ op: "begin", full, ...(read ? { read } : {}) });
      let live = true;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StoreDeadline(deadlineMs)), deadlineMs);
      });
      let value: T;
      try {
        // The worker answers in order: a statement already sent finishes before the rollback a deadline sends after it.
        const running = callback(this.#executor(() => live));
        // Past the deadline the callback's own end is nobody's: its refused next statement must not surface as an
        // unhandled rejection.
        running.catch(() => undefined);
        value = await Promise.race([running, deadline]);
      } catch (error) {
        live = false;
        clearTimeout(timer);
        try {
          await this.#send({ op: "rollback" });
        } catch (rollback) {
          // A worker lost mid-transaction failed both: its loss is the one error, as every later call's.
          if (this.#lost) throw this.#lost;
          throw new AggregateError([error, rollback], "the store's transaction failed, and so did its rollback");
        }
        throw error;
      }
      live = false;
      clearTimeout(timer);
      await this.#send({ op: "commit" });
      return value;
    });
  }

  /** Waits for every call queued before it, closes the connection (and the owner lock) and ends the worker. */
  async close(): Promise<void> {
    if (this.#closed) return;
    // A worker already lost has nothing left to close.
    if (this.#lost) {
      this.#closed = true;
      return;
    }
    const last = this.#queued(async () => this.#send({ op: "close" }));
    this.#closed = true;
    try {
      await last;
    } finally {
      this.#closing = true;
      await this.#worker.terminate();
    }
  }
}
