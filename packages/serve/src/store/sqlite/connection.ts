// The main thread's side of the store's one connection (worker.ts). It is a Chord SqliteDatabase
// (@earendil-works/chord/sqlite: exec, run, runCounted, get, all, transaction, close), the shape pi's SqliteStorage takes,
// so the journal (store/journal) runs on it as written. Every call is a message to the worker, answered in order, on one
// queue: a call starts when the one before it has answered, and a transaction holds every other call until it commits or
// rolls back. Errors come back typed: Fenced, RunFinal, StoreBusy, StoreConstraint, StoreClosed, StoreOwned.
import { Worker } from "node:worker_threads";
import { Fenced, RunFinal, StoreBusy, StoreClosed, StoreConstraint, StoreDeadline, StoreOwned } from "../store.js";
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

export class Connection implements SqliteDatabase {
  readonly #worker: Worker;
  #next = 1;
  readonly #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** The tail of the queue: each call chains on it. */
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

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
    worker.on("error", (error) => {
      for (const waiter of this.#waiting.values()) waiter.reject(new Error(`the store's worker failed: ${error.message}`));
      this.#waiting.clear();
    });
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
    } catch (error) {
      await worker.terminate();
      throw error;
    }
    return connection;
  }

  /** A message straight to the worker, outside the queue: only the queue's own steps call it. */
  #send(request: Request): Promise<unknown> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      this.#worker.ref();
      this.#worker.postMessage({ id, request });
    });
  }

  /** Runs `work` when every call queued before it has answered. */
  #queued<T>(work: () => Promise<T>): Promise<T> {
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
   *  error, or with an AggregateError when the rollback fails too. `full`: a FULL commit. Every other call of this process
   *  waits for it, so the callback awaits nothing but its own statements (no model or tool call inside), and a transaction
   *  still open `deadlineMs` after it began is rolled back and rejects with StoreDeadline: a later statement of its callback
   *  is refused, and the calls behind it go on. */
  transaction<T>(callback: (transaction: Tx) => Promise<T>, { full = false, deadlineMs = DEFAULT_TRANSACTION_DEADLINE_MS }: { full?: boolean; deadlineMs?: number } = {}): Promise<T> {
    return this.#queued(async () => {
      await this.#send({ op: "begin", full });
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
    const last = this.#queued(async () => this.#send({ op: "close" }));
    this.#closed = true;
    try {
      await last;
    } finally {
      await this.#worker.terminate();
    }
  }
}
