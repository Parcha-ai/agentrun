import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, type Cursor, type JsonObject, type Session, type SessionDocFamilyToken, type Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { existsSync } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

/** One answer of a home check: what a pack or an import judged, by the contract's check names. Only `fail` refuses. */
export type HomeCheck = {
  name: "format" | "definition" | "tools" | "sign_ins" | "vault" | "quote" | "size" | "live_runs";
  status: "ok" | "warn" | "fail";
  message: string;
  detail?: Record<string, unknown>;
};

/** What went wrong, by kind: `invalid` input, an agent home or run that `exists` or is `missing`, a home that stays
 *  `busy` past the wait, a `format` this version does not read, a home whose cache or revision is `stale` for the one
 *  asked, a pack that is `too_large`, or a pack or import that failed a `check` (`checks` says which). */
export class AgentHomeError extends Error {
  readonly code: "invalid" | "exists" | "missing" | "busy" | "format" | "stale" | "too_large" | "check";
  /** The checks behind a `check` refusal, all of them, the failed ones with status `fail`. */
  readonly checks?: HomeCheck[];
  constructor(code: AgentHomeError["code"], message: string, options?: ErrorOptions & { checks?: HomeCheck[] }) {
    super(message, options);
    this.name = "AgentHomeError";
    this.code = code;
    if (options?.checks) this.checks = options.checks;
  }
}

export type Store = {
  readonly storage: Storage;
  readonly session: Session;
  /** The store's head commit number, read on its own connection. */
  head(): Promise<number>;
  close(): Promise<void>;
};

/** The SQL that reads pi's next commit number. pi's Storage has no head query; its SQLite storage gives each commit
 *  `durable_metadata.next_seq` and stores the successor in the same transaction, so the head is `next_seq - 1`. */
export const HEAD_SQL = "SELECT next_seq FROM durable_metadata WHERE singleton = 1";

/** The head commit number from `HEAD_SQL`'s row. It fails closed (`format`) on a missing row and on a `next_seq` that is
 *  not a safe integer of at least 1: absent, null, text, fractional, zero, negative or past 2^53 - 1. */
export function headOf(row: { next_seq?: unknown } | undefined): number {
  const value = row?.next_seq;
  const next = typeof value === "bigint" ? Number(value) : value;
  if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 1) {
    const seen = row === undefined ? "no durable_metadata row" : `next_seq ${typeof value === "bigint" ? `${value}n` : JSON.stringify(value) ?? String(value)}`;
    throw new AgentHomeError("format", `the agent store has no usable head commit (${seen})`);
  }
  return next - 1;
}

/** The head commit number from one `HEAD_SQL` read; a read that throws (no `durable_metadata` table, a value
 *  node:sqlite will not return) fails closed (`format`) too. */
export async function readHead(read: () => unknown): Promise<number> {
  let row: unknown;
  try {
    row = await read();
  } catch (error) {
    throw new AgentHomeError("format", "the agent store has no readable head commit", { cause: error });
  }
  return headOf(row as { next_seq?: unknown } | undefined);
}

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
  return { storage, session, head: () => readHead(() => database.get(HEAD_SQL)), close: () => session.close(BACKGROUND_CONTEXT) };
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

/** The record of an import in progress, kept in the home. An import moves run directories before the store commits, so
 *  a crash between the two leaves this file for the next lock taker to settle: `recoverImport`. */
export const IMPORT_JOURNAL = ".import-journal";
/** One run directory an import replaces: whether the home had one (it is set aside in `<staging>/backup/<id>`) and
 *  whether the pack brought one (extracted under the staging directory's `home` folder, in `runs/<id>`). */
export type ImportMove = { id: string; hadOld: boolean; hasNew: boolean };
/** `moving` until the import is settled one way or the other, then `committed` (the store's commit has returned) or
 *  `rolled-back` (every run directory is back where it was). A settled journal is written, on disk, before any of its
 *  evidence is removed, and says only that what is left of the evidence is to be removed. */
export type ImportPhase = "moving" | "committed" | "rolled-back";
/** `from` is the store's head commit before the import; `staging` is the directory beside the home that holds the
 *  extracted pack and the set-aside run directories. */
export type ImportJournal = { version: 1; phase?: ImportPhase; staging: string; from: number; moves: ImportMove[] };
const AGENT_STORE = "agent.sqlite"; // AGENT_STORE_FILE, which home.ts defines and imports this file for

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Replace the journal whole or not at all: written and synced beside it, renamed over it, the directory synced. */
async function putJournal(home: string, journal: ImportJournal): Promise<void> {
  const file = path.join(home, IMPORT_JOURNAL);
  const part = `${file}.tmp`;
  try {
    await rm(part, { force: true });
    const handle = await open(part, "w", 0o600);
    try {
      await handle.write(JSON.stringify(journal));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(part, file);
    await syncDirectory(home);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

/** Write the journal, on disk before the first run directory moves. */
export const writeJournal = (home: string, journal: Omit<ImportJournal, "phase">): Promise<void> => putJournal(home, { ...journal, phase: "moving" });
/** Record, on disk, that the store's commit has returned. Nothing is cleaned up before this. */
export const markCommitted = (home: string, journal: Omit<ImportJournal, "phase">): Promise<void> => putJournal(home, { ...journal, phase: "committed" });

/** @internal Called by recovery after a settled phase is on disk and after the staging directory is removed. A test
 *  throws from it to stop recovery there, as a crash would. */
export const recoveryHook: { after?: (step: "marked" | "staging-removed") => void | Promise<void> } = {};

const RUN_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function parseJournal(text: string): ImportJournal | undefined {
  try {
    const value = JSON.parse(text) as Partial<ImportJournal> | null;
    const moves = value?.moves;
    if (value?.version !== 1 || typeof value.staging !== "string" || !Number.isSafeInteger(value.from) || !Array.isArray(moves)) return undefined;
    if (value.phase !== undefined && value.phase !== "moving" && value.phase !== "committed" && value.phase !== "rolled-back") return undefined;
    if (!moves.every((move) => move && typeof move.id === "string" && RUN_DIR.test(move.id) && typeof move.hadOld === "boolean" && typeof move.hasNew === "boolean")) return undefined;
    return value as ImportJournal;
  } catch {
    return undefined;
  }
}

/**
 * Settle an import that did not finish, under the home's lock. Safe to repeat any number of times, so a crash during
 * recovery is recovered next time.
 *
 * A journal that is `committed` or `rolled-back` is settled: its run directories are not judged again, and whatever is
 * left of its evidence is removed, the staging directory first and the journal last.
 *
 * A journal still `moving` is judged once. The commit landed when the store's head moved past `from`; then each new run
 * directory is made sure to be in place. Otherwise every run directory goes back: the pack's ones to where they were
 * extracted, the old ones from `<staging>/backup`. It never deletes a run directory it cannot account for: when one it
 * would restore, or one that should have arrived, is in neither of its places, nothing is changed and nothing is removed,
 * the journal and the staging directory stay, and the error names them, for a person.
 *
 * The verdict is written to the journal, on disk, before any evidence goes: after that nothing is judged again, so a stop
 * between removing the staging directory and removing the journal leaves a journal that only has to be removed.
 */
export async function recoverImport(home: string): Promise<void> {
  const file = path.join(home, IMPORT_JOURNAL);
  const journal = parseJournal(await readFile(file, "utf8").catch(() => ""));
  if (!journal) throw new AgentHomeError("format", `the import journal ${IMPORT_JOURNAL} in the agent home is not one this version wrote; check runs/ against the directory it names, then remove it`);
  const staging = path.resolve(journal.staging);
  if (path.dirname(staging) !== path.dirname(home) || !path.basename(staging).startsWith(`.${path.basename(home)}.import-`)) {
    throw new AgentHomeError("format", `the import journal names ${staging}, which is not a staging directory beside the home; nothing was removed`);
  }
  if ((journal.phase ?? "moving") === "moving") {
    const store = await openStore(path.join(home, AGENT_STORE));
    let head: number;
    try { head = await store.head(); } finally { await store.close(); }
    const committed = head > journal.from;
    const where = (id: string) => ({ target: path.join(home, "runs", id), backup: path.join(staging, "backup", id), staged: path.join(staging, "home", "runs", id) });
    const stuck: string[] = [];
    const steps: Array<() => Promise<void>> = [];
    for (const move of journal.moves) {
      const { target, backup, staged } = where(move.id);
      const [inTarget, inBackup, inStaged] = [existsSync(target), existsSync(backup), existsSync(staged)];
      if (committed) {
        if (move.hasNew && !inTarget) {
          if (inStaged) steps.push(() => rename(staged, target));
          else if (inBackup) stuck.push(`${move.id} (the imported directory is gone and the old one is the only copy)`);
        }
      } else if (inBackup) {
        if ((inTarget && inStaged) || (inTarget && !move.hasNew)) stuck.push(`${move.id} (a directory stands where the old one goes, and the pack's copy has no place to return to)`);
        else steps.push(async () => {
          if (inTarget) await rename(target, staged);
          await rename(backup, target);
        });
      } else if (move.hadOld) {
        if (!inTarget || (move.hasNew && !inStaged)) stuck.push(`${move.id} (the old directory is in neither its place nor the backup)`);
      } else if (move.hasNew && !inStaged && inTarget) {
        steps.push(() => rename(target, staged));
      }
    }
    if (stuck.length) {
      throw new AgentHomeError("format", `the import journal in the agent home cannot be settled without deleting a run directory: ${stuck.join("; ")}. Nothing was changed or removed; the journal and ${staging} are kept for a person`);
    }
    for (const step of steps) await step();
    await putJournal(home, { ...journal, phase: committed ? "committed" : "rolled-back" });
    await recoveryHook.after?.("marked");
  }
  await rm(staging, { recursive: true, force: true });
  await recoveryHook.after?.("staging-removed");
  await rm(file, { force: true });
}

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
    try {
      if (existsSync(path.join(key, IMPORT_JOURNAL))) await recoverImport(key);
      return await work();
    } finally {
      release();
    }
  } finally {
    done();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
