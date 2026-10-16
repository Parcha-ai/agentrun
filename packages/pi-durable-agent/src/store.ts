import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, type Cursor, type JsonObject, type Session, type SessionDocFamilyToken, type Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

/** What went wrong, by kind: `invalid` input, an agent home or run that `exists` or is `missing`, a home that stays
 *  `busy` past the wait, a `format` this version does not read, or a home whose cache is `stale` for the sha asked. */
export class AgentHomeError extends Error {
  readonly code: "invalid" | "exists" | "missing" | "busy" | "format" | "stale";
  constructor(code: AgentHomeError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentHomeError";
    this.code = code;
  }
}

export type Store = { readonly storage: Storage; readonly session: Session; close(): Promise<void> };

const SYNCHRONOUS_FULL = 2;

/** Open the pi-durable store at `file` at synchronous = FULL, read back, so a commit is on disk before it resolves. */
export async function openStore(file: string): Promise<Store> {
  const database = await openNodeSqliteDatabase(file);
  try {
    await database.exec("PRAGMA synchronous = FULL");
    const row = await database.get<{ synchronous: number }>("PRAGMA synchronous");
    if (row?.synchronous !== SYNCHRONOUS_FULL) throw new AgentHomeError("format", `the store ${path.basename(file)} did not accept synchronous = FULL (reads ${String(row?.synchronous)})`);
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
  const storage = await SqliteStorage.open(database);
  const session = createSession(storage);
  return { storage, session, close: () => session.close(BACKGROUND_CONTEXT) };
}

/** Every current member of a session-scoped family, by key. */
export async function readFamily<T>(store: Store, token: SessionDocFamilyToken<JsonObject, null>): Promise<Record<string, T>> {
  const entries: [string, T][] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await store.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: token.definition.kind }, 256, cursor, BACKGROUND_CONTEXT);
    for (const { key } of page.items) {
      if (key === undefined) continue;
      const value = await store.session.snapshot(token, key, BACKGROUND_CONTEXT);
      if (value) entries.push([key, structuredClone(value) as T]);
    }
    cursor = page.next;
  } while (cursor);
  return Object.fromEntries(entries);
}

export const LOCK_FILE = "owner.lock";
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const isBusy = (error: unknown): boolean => {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && [SQLITE_BUSY, SQLITE_LOCKED].includes(code & 0xff);
};

// A held lock's handle stays referenced until release: a collected DatabaseSync closes its file, and closing the
// descriptor drops the POSIX lock.
const held = new Set<DatabaseSync>();

/** Take the exclusive lock on `file` (an empty SQLite database), retrying with backoff for up to `waitMs`. The kernel
 *  drops it when the holder dies, so a dead holder never needs a liveness check. */
async function takeLock(file: string, waitMs: number): Promise<() => void> {
  const end = Date.now() + waitMs;
  for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
    const db = new DatabaseSync(file, { timeout: 0 });
    try {
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("COMMIT");
    } catch (error) {
      try { db.close(); } catch { /* this handle never held the lock */ }
      if (!isBusy(error)) throw error;
      if (Date.now() + delay > end) throw new AgentHomeError("busy", `the agent home is held by another writer for more than ${waitMs} ms`, { cause: error });
      await sleep(delay);
      continue;
    }
    held.add(db);
    return () => { if (held.delete(db)) db.close(); };
  }
}

const queues = new Map<string, Promise<void>>();

/** Run `work` as the agent home's only writer: in turn with this process's other callers, then under the home's
 *  cross-process lock. Every open of `agent.sqlite` happens inside, because a SqliteStorage mints ids from what it read
 *  at open: two open writers would collide. */
export async function withHome<T>(dir: string, work: () => Promise<T>, waitMs = 5_000): Promise<T> {
  const key = path.resolve(dir);
  const before = queues.get(key) ?? Promise.resolve();
  let done!: () => void;
  const gate = new Promise<void>((resolve) => { done = resolve; });
  const tail = before.then(() => gate);
  queues.set(key, tail);
  await before;
  try {
    const release = await takeLock(path.join(key, LOCK_FILE), waitMs);
    try { return await work(); } finally { release(); }
  } finally {
    done();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
