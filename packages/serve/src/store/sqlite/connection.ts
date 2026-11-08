// The main thread's side of the store's one connection (worker.ts): every call is a message to the worker, answered in
// order. One queue: a call starts when the one before it has answered, so a write never interleaves another, and an
// interactive transaction (transaction()) holds every other call until it commits or rolls back. Errors come back typed:
// Fenced, RunFinal, StoreBusy, StoreConstraint, StoreClosed.
import { Worker } from "node:worker_threads";
import { Fenced, RunFinal, StoreBusy, StoreClosed, StoreConstraint } from "../store.js";
import type { Params, Reply, Request, Statement, StatementResult, WorkerError } from "./worker.js";

export type { Params, Statement, StatementResult } from "./worker.js";

/** An open interactive transaction: its statements run in order inside one BEGIN IMMEDIATE. */
export interface Tx {
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
    default:
      return new Error(`the store's SQLite: ${error.message}`);
  }
}

export class Connection {
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

  /** Starts the worker and opens `file` in it. */
  static async open(file: string, { busyTimeoutMs = 10_000 }: { busyTimeoutMs?: number } = {}): Promise<Connection> {
    const connection = new Connection(new Worker(new URL("./worker.js", import.meta.url)));
    await connection.#send({ op: "open", file, busyTimeoutMs });
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

  /** The first row of a read, or undefined. */
  get<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T | undefined> {
    return this.#queued(async () => ((await this.#send({ op: "read", sql, all: false, ...(params ? { params } : {}) })) ?? undefined) as T | undefined);
  }

  /** Every row of a read. */
  all<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T[]> {
    return this.#queued(async () => (await this.#send({ op: "read", sql, all: true, ...(params ? { params } : {}) })) as T[]);
  }

  /** One write transaction: `statements` in order; an expectation miss or an error rolls all of them back. `full`: a FULL
   *  commit, durable against a lost box together with every commit before it. */
  write(statements: readonly Statement[], { full = false }: { full?: boolean } = {}): Promise<StatementResult[]> {
    return this.#queued(async () => (await this.#send({ op: "write", statements, full })) as StatementResult[]);
  }

  /** An interactive write transaction: `work` steps its statements, deciding each from the ones before it; it commits when
   *  `work` resolves and rolls back when it throws (or a step misses). Every other call waits for it. */
  transaction<T>(work: (tx: Tx) => Promise<T>, { full = false }: { full?: boolean } = {}): Promise<T> {
    return this.#queued(async () => {
      await this.#send({ op: "begin", full });
      let open = true;
      const tx: Tx = {
        step: async (statement) => {
          if (!open) throw new Error("the store's transaction is over");
          try {
            return (await this.#send({ op: "step", statement })) as StatementResult;
          } catch (error) {
            // The worker ended the transaction on a failed step.
            open = false;
            throw error;
          }
        },
      };
      try {
        const value = await work(tx);
        if (open) await this.#send({ op: "commit" });
        else throw new Error("the store's transaction ended on a failed step");
        return value;
      } catch (error) {
        if (open) await this.#send({ op: "rollback" }).catch(() => undefined);
        throw error;
      } finally {
        open = false;
      }
    });
  }

  /** Waits for every call queued before it, closes the connection and ends the worker. */
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
