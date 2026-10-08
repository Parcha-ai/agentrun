// Shared by the local and live store suites: commit shapes, percentiles, the fault-injecting database, and a scoped store.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { EntryId, Storage, StorageWrite } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openArchilStore } from "../src/store.ts";
import type { ArchilStore, Profile } from "../src/store.ts";

export const ctx = BACKGROUND_CONTEXT;

export const SQLITE_IOERR = 10;
export const SQLITE_IOERR_WRITE = 778;
export const SQLITE_IOERR_FSYNC = 1034;
export const SQLITE_FULL = 13;
export const SQLITE_NOTADB = 26;

/** An error shaped like node:sqlite's: `code`, the extended result code in `errcode`, and `errstr`. */
export function sqliteError(errcode: number, message: string): Error {
  return Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode, errstr: message });
}

/** The first commit creates the root conversation; each later commit appends one entry (the cheapest FULL commit). */
export function entryCommitter(storage: Storage, payloadBytes = 256) {
  const pad = "x".repeat(payloadBytes);
  return {
    async setup(): Promise<void> {
      await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], ctx);
    },
    async commit(n: number): Promise<number> {
      const id = await storage.mintId<EntryId>();
      const writes: StorageWrite[] = [
        { type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "p2.chunk", data: { n, pad } } },
      ];
      return Number(await storage.commit(writes, ctx));
    },
  };
}

/** Nearest-rank percentile of an unsorted sample. */
export function percentile(sample: readonly number[], p: number): number {
  const sorted = [...sample].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/**
 * A database that delegates until `failNextCommit` is armed. The armed commit runs its callback for real and then fails
 * before COMMIT, so the transaction rolls back and nothing of it is durable: the shape of a commit whose fsync failed.
 */
export class FaultyDatabase implements SqliteDatabase {
  readonly inner: SqliteDatabase;
  #failure: unknown;

  constructor(inner: SqliteDatabase) {
    this.inner = inner;
  }

  failNextCommit(error: unknown): void {
    this.#failure = error;
  }

  exec(sql: string): Promise<void> {
    return this.inner.exec(sql);
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.inner.run(sql, ...params);
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.inner.get<T>(sql, ...params);
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.inner.all<T>(sql, ...params);
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    if (this.#failure === undefined) return this.inner.transaction(callback);
    const failure = this.#failure;
    return this.inner.transaction(async (transaction) => {
      await callback(transaction);
      throw failure;
    });
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/**
 * Open a store in a fresh directory under `root` (local disk or an Archil mount), run `use`, close the store (a close
 * failure surfaces) and remove exactly that directory.
 */
export async function withStoreIn<T>(root: string, profile: Profile, use: (store: ArchilStore, file: string) => Promise<T>): Promise<T> {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, `${profile}-`));
  const file = join(dir, "store", "run.sqlite");
  const store = await openArchilStore(file, profile);
  let result: T;
  try {
    result = await use(store, file);
  } catch (error) {
    await store.storage.close(ctx).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  try {
    await store.storage.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return result;
}
