// pi-durable's SqliteDatabase facade over a Worker that runs SQLite-WASM (sqlite-worker.ts). pi's own SqliteStorage runs on top of it
// unchanged, so the browser store is the same SQL the Node store runs, and pi's storage conformance suite is the test of both.
// Portable: the Worker is injected (a page's Worker, or a loopback in a Node test).
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteRequest, SqliteResponse } from "./sqlite-service.ts";

/** The Worker API the client uses. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate?(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: { message?: string }) => void): void;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;

/** A SQLite error as the worker reports it: the class's name and SQLite's result code survive the trip. */
function remoteError(error: { name: string; message: string; resultCode?: number }): Error {
  const out = new Error(error.message) as Error & { resultCode?: number };
  out.name = error.name;
  if (error.resultCode !== undefined) out.resultCode = error.resultCode;
  return out;
}

/** One request/answer line to a Worker. */
export class SqliteLine {
  readonly #worker: WorkerLike;
  readonly #pending = new Map<number, Pending>();
  #next = 1;
  #dead: Error | undefined;

  constructor(worker: WorkerLike) {
    this.#worker = worker;
    worker.addEventListener("message", (event) => {
      const response = event.data as SqliteResponse;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(remoteError(response.error));
    });
    const died = (event: { message?: string }) => this.#die(new Error(`the SQLite worker failed${event.message ? `: ${event.message}` : ""}`));
    worker.addEventListener("error", died);
    worker.addEventListener("messageerror", died);
  }

  #die(error: Error): void {
    this.#dead ??= error;
    for (const pending of this.#pending.values()) pending.reject(this.#dead);
    this.#pending.clear();
  }

  call<T = unknown>(request: Distribute<SqliteRequest>): Promise<T> {
    if (this.#dead) return Promise.reject(this.#dead);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.#worker.postMessage({ ...request, id });
      } catch (error) {
        this.#pending.delete(id);
        reject(error as Error);
      }
    });
  }

  terminate(): void {
    this.#die(new Error("the SQLite worker was terminated"));
    this.#worker.terminate?.();
  }
}

class Handle implements SqliteExecutor {
  protected readonly line: SqliteLine;
  constructor(line: SqliteLine) {
    this.line = line;
  }
  exec(sql: string): Promise<void> {
    return this.line.call<void>({ op: "exec", sql });
  }
  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.line.call<void>({ op: "run", sql, params });
  }
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.line.call<T | undefined>({ op: "get", sql, params });
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.line.call<T[]>({ op: "all", sql, params });
  }
}

/** A transaction's statements, valid until its callback settles. */
class TransactionHandle extends Handle {
  readonly #scope: { active: boolean };
  constructor(line: SqliteLine, scope: { active: boolean }) {
    super(line);
    this.#scope = scope;
  }
  override exec(sql: string): Promise<void> {
    return this.#guard(() => super.exec(sql));
  }
  override run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.#guard(() => super.run(sql, ...params));
  }
  override get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.#guard(() => super.get<T>(sql, ...params));
  }
  override all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#guard(() => super.all<T>(sql, ...params));
  }
  #guard<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#scope.active) return Promise.reject(new Error("SQLite transaction handle is no longer active"));
    return operation();
  }
}

/**
 * The database a Worker holds. Operations outside a transaction wait for the one in progress, as `SqliteDatabase` requires; the
 * transaction's own handle goes straight to the worker.
 */
export class WorkerDatabase extends Handle implements SqliteDatabase {
  readonly #owned: boolean;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(line: SqliteLine, owned = true) {
    super(line);
    this.#owned = owned;
  }

  /** Run `operation` after everything queued before it, and hold the queue until it settles. */
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const before = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => (release = resolve));
    return before.then(operation).finally(release);
  }

  override exec(sql: string): Promise<void> {
    return this.#exclusive(() => super.exec(sql));
  }
  override run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.#exclusive(() => super.run(sql, ...params));
  }
  override get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.#exclusive(() => super.get<T>(sql, ...params));
  }
  override all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#exclusive(() => super.all<T>(sql, ...params));
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.#exclusive(async () => {
      await this.line.call({ op: "exec", sql: "BEGIN IMMEDIATE" });
      const scope = { active: true };
      try {
        const result = await callback(new TransactionHandle(this.line, scope));
        scope.active = false;
        await this.line.call({ op: "exec", sql: "COMMIT" });
        return result;
      } catch (error) {
        scope.active = false;
        try {
          await this.line.call({ op: "exec", sql: "ROLLBACK" });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#closed) return;
      this.#closed = true;
      try {
        await this.line.call({ op: "close" });
      } finally {
        if (this.#owned) this.line.terminate();
      }
    });
  }
}

/** pi's SqliteStorage on a worker's database, with the database itself (the head of the store is read from it). */
export type WorkerStore = { storage: SqliteStorage; database: WorkerDatabase };

/** Open database `name` in the worker and run pi's SqliteStorage on it. Closing the storage closes the database and ends the worker. */
export async function openWorkerStore(worker: WorkerLike, name: string): Promise<WorkerStore> {
  const line = new SqliteLine(worker);
  try {
    await line.call({ op: "open", name });
    const database = new WorkerDatabase(line);
    return { storage: await SqliteStorage.open(database), database };
  } catch (error) {
    line.terminate();
    throw error;
  }
}

/** The sequence of the last commit in the store: `durable_metadata.next_seq` less one (what the pipe reads from the run's own store). */
export async function storeHead(database: SqliteExecutor): Promise<number> {
  const row = await database.get<{ next_seq?: unknown }>("SELECT next_seq FROM durable_metadata WHERE singleton = 1");
  const next = typeof row?.next_seq === "bigint" ? Number(row.next_seq) : row?.next_seq;
  if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 1) throw new Error(`the store has no usable durable_metadata.next_seq (${JSON.stringify(row ?? null)})`);
  return next - 1;
}
