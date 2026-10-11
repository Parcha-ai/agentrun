// The run's store in this browser: a SQLite database on the origin's private file system (OPFS), opened by pi's SqliteStorage through
// the SQLite worker (sqlite-worker.ts). A page owns the pool while its worker lives, so every function here starts a worker, does its one
// thing and ends it; `openLocalStore` keeps its worker until the storage is closed.
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openWorkerStore, SqliteLine, storeHead, type WorkerDatabase, type WorkerLike } from "./sqlite-client.ts";

/** Where the page serves the worker and its wasm (absolute: the page itself is at /run/<id>). */
export const STORE_WORKER_URL = "/vendor/sqlite-worker.js";

/** A run's database in the pool (the pool wants absolute names). */
export const storeName = (run: string): string => `/run-${run.replace(/[^A-Za-z0-9._-]/g, "_")}.sqlite3`;

export function spawnStoreWorker(url: string = new URL(STORE_WORKER_URL, location.origin).href): WorkerLike {
  return new Worker(url, { type: "module" }) as unknown as WorkerLike;
}

export interface LocalStore {
  readonly storage: SqliteStorage;
  readonly database: WorkerDatabase;
  /** The sequence of the last commit in this store. */
  head(): Promise<number>;
}

/** Open run `run`'s database. Closing `storage` closes it and ends the worker. */
export async function openLocalStore(run: string, worker: WorkerLike = spawnStoreWorker()): Promise<LocalStore> {
  const { storage, database } = await openWorkerStore(worker, storeName(run));
  return { storage, database, head: () => storeHead(database) };
}

/** Run `use` with a worker whose pool nothing else holds, then end the worker. */
async function withPool<T>(use: (line: SqliteLine) => Promise<T>, worker: WorkerLike = spawnStoreWorker()): Promise<T> {
  const line = new SqliteLine(worker);
  try {
    return await use(line);
  } finally {
    line.terminate();
  }
}

/** Put a copy of the run's store (a whole SQLite file, as the pipe served it) in place, replacing any earlier copy. */
export function importStore(run: string, bytes: Uint8Array, worker?: WorkerLike): Promise<number> {
  return withPool((line) => line.call<number>({ op: "import", name: storeName(run), bytes }), worker);
}

/** The store's file, whole, as it is now (nothing may have it open). */
export function exportStore(run: string, worker?: WorkerLike): Promise<Uint8Array> {
  return withPool((line) => line.call<Uint8Array>({ op: "export", name: storeName(run) }), worker);
}

export function hasStore(run: string, worker?: WorkerLike): Promise<boolean> {
  return withPool(async (line) => (await line.call<string[]>({ op: "files" })).includes(storeName(run)), worker);
}

export function deleteStore(run: string, worker?: WorkerLike): Promise<boolean> {
  return withPool((line) => line.call<boolean>({ op: "unlink", name: storeName(run) }), worker);
}
