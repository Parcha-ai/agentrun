// The run's record: its status, generation, holder, `wakeAt` and `detail`, which the run's process keeps in its own store
// (RUN_STATUS_TABLE, one row) and nothing else writes. `readLocalRunStatus` reads it once no process holds the run.
import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@earendil-works/chord";
import { EXIT_DATAERR, FencedError, HeldError, PdaError } from "./errors.ts";
import { fdPath, hold } from "./held-fd.ts";
import { thisBoot } from "./process-table.ts";

/** The table of the run's store that holds its record: one row, its record as JSON. */
export const RUN_STATUS_TABLE = "pda_run_status";

export const RUN_STATUSES = ["running", "sleeping", "paused", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The box an open's run ran in, as the host resolved it for that open (serve's capabilities.box.mode). */
export const BOX_MODES = ["bwrap", "seatbelt", "provider", "unsandboxed", "unavailable"] as const;
export type BoxMode = (typeof BOX_MODES)[number];

/**
 * The incarnation that wrote the record: its host's name and enough to tell its process. Fields beyond the five named
 * here are the host's own handle (a door, start ticks), kept as written.
 */
export interface RunHolder {
  readonly driver: string;
  readonly host: string;
  /** `/proc/sys/kernel/random/boot_id` (`kern.bootsessionuuid` on macOS); null where it cannot be read. */
  readonly bootId: string | null;
  readonly pid: number;
  /** When this incarnation claimed the run (ISO 8601). */
  readonly since: string;
  readonly [field: string]: JsonValue;
}

export interface RunRecord {
  readonly run: string;
  readonly status: RunStatus;
  /** The incarnation that wrote it: its host's epoch, or the previous record's generation plus 1. */
  readonly generation: number;
  /** When a `sleeping` run should be started again (ISO 8601); null otherwise. */
  readonly wakeAt: string | null;
  readonly holder: RunHolder | null;
  /** Wall-clock time of the last status transition (ISO 8601). */
  readonly updatedAt: string;
  readonly detail: JsonValue | null;
  /** The box this incarnation's run runs in, exactly as its open was given it (`boxMode`); absent when it was given none.
   *  The next open reads it to tell a switch of box from this open's. */
  readonly box?: { readonly mode: BoxMode };
}

/** A run's record is missing a field, has one of the wrong type, or is not JSON. Exit 65 (EX_DATAERR): a restart cannot fix it. */
export class RunRecordError extends PdaError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("RUN_JSON_INVALID", message, { cause: options.cause, exitCode: EXIT_DATAERR });
  }
}

const isInstant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function holderOf(value: unknown): RunHolder | null {
  if (value === null) return null;
  const h = value as Record<string, JsonValue> | undefined;
  if (typeof h !== "object" || h === undefined || Array.isArray(h)) throw new RunRecordError("holder is not an object or null");
  if (typeof h.driver !== "string" || typeof h.host !== "string") throw new RunRecordError("holder.driver and holder.host must be strings");
  if (h.bootId !== null && typeof h.bootId !== "string") throw new RunRecordError("holder.bootId must be a string or null");
  if (!Number.isSafeInteger(h.pid) || (h.pid as number) <= 0) throw new RunRecordError("holder.pid must be a positive integer");
  if (!isInstant(h.since)) throw new RunRecordError("holder.since must be an ISO 8601 instant");
  return { ...h, driver: h.driver, host: h.host, bootId: h.bootId, pid: h.pid as number, since: h.since };
}

/** Parse and validate a record's text. Unknown fields are ignored, so a newer writer stays readable. Throws RunRecordError on anything else. */
export function parseRunRecord(text: string): RunRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new RunRecordError("the run's record is not JSON", { cause });
  }
  const r = value as Partial<Record<keyof RunRecord, unknown>> | null;
  if (typeof r !== "object" || r === null || Array.isArray(r)) throw new RunRecordError("the run's record is not an object");
  if (typeof r.run !== "string" || r.run === "") throw new RunRecordError("run must be a non-empty string");
  if (!(RUN_STATUSES as readonly unknown[]).includes(r.status)) throw new RunRecordError(`status ${JSON.stringify(r.status)} is not one of ${RUN_STATUSES.join(", ")}`);
  if (!isCount(r.generation)) throw new RunRecordError("generation must be a non-negative integer");
  if (r.wakeAt !== null && !isInstant(r.wakeAt)) throw new RunRecordError("wakeAt must be an ISO 8601 instant or null");
  if (!isInstant(r.updatedAt)) throw new RunRecordError("updatedAt must be an ISO 8601 instant");
  const box = r.box as { mode?: unknown } | undefined | null;
  if (box !== undefined && (typeof box !== "object" || box === null || !(BOX_MODES as readonly unknown[]).includes(box.mode))) {
    throw new RunRecordError(`box must be { mode: one of ${BOX_MODES.join(", ")} }`);
  }
  return {
    run: r.run,
    status: r.status as RunStatus,
    generation: r.generation,
    wakeAt: r.wakeAt as string | null,
    holder: holderOf(r.holder),
    updatedAt: r.updatedAt,
    detail: r.detail === undefined ? null : (r.detail as JsonValue),
    ...(box === undefined ? {} : { box: { mode: box.mode as BoxMode } }),
  };
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_ERROR = 1;

/**
 * The record of a run on a local directory (`localRun`), `root` being the directory `localRun(root)` takes: read from the
 * run's store once no process holds the run (after it released it, exited or died). It opens the store as a run's
 * process does, read-write in its exclusive locking mode, for one read. While a process holds the run that read meets
 * the holder's lock: HeldError `store` (76), with nothing read, written or removed. On a store nobody holds, the read's
 * close checkpoints what the WAL committed into the database file, as the next open's would; and while the read holds
 * the lock (its own duration), a run that starts on that store is refused as held. So it is for a read after the fact,
 * not for polling a run that is about to start. No store, or no record in it yet: null. A malformed record:
 * RunRecordError (`RUN_JSON_INVALID`).
 */
export async function readLocalRunStatus(root: string): Promise<RunRecord | null> {
  return readStoreRecord(join(root, "store", "run.sqlite"));
}

/** `readLocalRunStatus` on the store file `file` itself. */
export async function readStoreRecord(file: string): Promise<RunRecord | null> {
  try {
    await stat(file);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR") return null;
    throw error;
  }
  let db: DatabaseSync | undefined;
  let text: string | undefined;
  try {
    db = new DatabaseSync(file, { timeout: 0 });
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    try {
      text = (db.prepare(`SELECT record FROM ${RUN_STATUS_TABLE} WHERE id = 1`).get() as { record?: string } | undefined)?.record;
    } catch (error) {
      // A store with no record table yet (a run that never opened) has no record.
      if ((Number((error as { errcode?: number }).errcode) & 0xff) === SQLITE_ERROR && /no such table/.test((error as Error).message)) return null;
      throw error;
    }
  } catch (error) {
    const code = Number((error as { errcode?: number }).errcode) & 0xff;
    if (code === SQLITE_BUSY || code === SQLITE_LOCKED) throw new HeldError("store", `${file} is held by the run's process`, { cause: error });
    throw error;
  } finally {
    db?.close();
  }
  return text === undefined ? null : parseRunRecord(text);
}

// ---- the claim directory ----------------------------------------------------------------------------------------------

/** The FencedError code of a claim root that is no longer the mount the instance opened (unmounted, lazily or not). */
export const CLAIM_UNMOUNTED = "CLAIM_UNMOUNTED";

/**
 * A run root held open as a directory for the life of the instance. `at` is `/proc/self/fd/<n>`, a path the kernel
 * resolves through the open directory and never through the root's path (Node has no openat; the magic link stands in
 * for it): a file made, written or renamed under `at` is in the directory opened at acquire, or the call fails (ENOTCONN
 * once the FUSE daemon is gone). It never lands on the local disk under a mountpoint whose mount went away. macOS has no
 * such link: there `at` is the root's path (`byPath`), and only the checks below stand between a write and a root that was
 * replaced.
 */
export interface ClaimDir {
  /** The root's path, as the claim names it. */
  readonly root: string;
  /** `/proc/self/fd/<n>`, or the root's path `byPath`. Throws once closed: the number may then name another file. */
  readonly at: string;
  /**
   * Resolves while the root's path still resolves to the directory held open (same device, same inode). A mount that was
   * unmounted (lazily, by an operator, or by its daemon's `auto_unmount`) leaves the path on another device, and a dead
   * daemon fails the stat: both reject with a FencedError CLAIM_UNMOUNTED. The stat runs off the main thread.
   */
  assertMounted(): Promise<void>;
  /** Resolves while `<root>/<name>` by path is the entry `name` of the directory held open, on its device; else as `assertMounted`. */
  assertSame(name: string): Promise<void>;
  /** Close the directory (idempotent). A caller closes it only once nothing can still address `at`. */
  close(): Promise<void>;
}

export interface OpenClaimDirOptions {
  /**
   * `at` is the root's path, not `/proc/self/fd/<n>`: the default on macOS, which has none. A write is checked against the
   * held directory first (`assertMounted`), but a root renamed and replaced between that check and the write gets the
   * write. For a local directory only.
   */
  readonly byPath?: boolean;
}

/** `major:minor` of a device number, as `/proc/self/mountinfo` writes it (glibc's encoding). */
export function deviceName(dev: bigint): string {
  const major = ((dev & 0xfff00n) >> 8n) | ((dev & 0xfffff00000000000n) >> 32n);
  const minor = (dev & 0xffn) | ((dev & 0xffffff00000n) >> 12n);
  return `${major}:${minor}`;
}

const unmounted = (message: string, cause?: unknown) => new FencedError(message, { code: CLAIM_UNMOUNTED, cause });

/** Open `root` as the claim's directory; a root that cannot be opened is a FencedError CLAIM_UNMOUNTED (exit 75). */
export async function openClaimDir(root: string, options: OpenClaimDirOptions = {}): Promise<ClaimDir> {
  let handle: FileHandle;
  try {
    handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    throw unmounted(`opening the claim root ${root} failed: ${(error as Error).message}`, error);
  }
  let held: { dev: bigint; ino: bigint };
  try {
    held = await handle.stat({ bigint: true });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error instanceof FencedError ? error : unmounted(`checking the claim root ${root} failed: ${(error as Error).message}`, error);
  }
  const byPath = options.byPath ?? process.platform === "darwin";
  // Held until close(): `at` names the directory by its number, and a collection must never free that number.
  const at = byPath ? (hold(handle), root) : fdPath(handle);
  let closed = false;
  const same = (path: string, now: { dev: bigint; ino: bigint }, claims: { dev: bigint; ino: bigint }) => {
    if (now.dev === claims.dev && now.ino === claims.ino) return;
    throw unmounted(`${path} is device ${deviceName(now.dev)} inode ${now.ino}, not the claim's device ${deviceName(claims.dev)} inode ${claims.ino}: the claim's mount is gone`);
  };
  const statOf = async (path: string) => {
    try {
      return await stat(path, { bigint: true });
    } catch (error) {
      throw unmounted(`stat of ${path} failed, so the claim's mount cannot be trusted: ${(error as Error).message}`, error);
    }
  };
  return {
    root,
    get at() {
      if (closed) throw new FencedError(`the claim directory of ${root} is closed`);
      return at;
    },
    async assertMounted() {
      if (closed) throw unmounted(`the claim directory of ${root} is closed`);
      same(root, await statOf(root), held);
    },
    async assertSame(name) {
      if (closed) throw unmounted(`the claim directory of ${root} is closed`);
      if (byPath) {
        // No second way to name the entry: the root must still be the directory held, and the entry on its device.
        const [dir, entry] = await Promise.all([statOf(root), statOf(join(root, name))]);
        same(root, dir, held);
        if (entry.dev !== held.dev) throw unmounted(`${name} in the claim directory is on device ${deviceName(entry.dev)}, not the claim's ${deviceName(held.dev)}`);
        return;
      }
      const [named, inDir] = await Promise.all([statOf(join(root, name)), statOf(join(at, name))]);
      if (inDir.dev !== held.dev) throw unmounted(`${name} in the claim directory is on device ${deviceName(inDir.dev)}, not the claim's ${deviceName(held.dev)}`);
      same(join(root, name), named, inDir);
    },
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

/**
 * This process as a holder: the host driver's `handle` (default driver `local`, this machine's host name and boot id)
 * with this process's pid and `since`. A handle whose named fields have the wrong type is refused (RunRecordError).
 */
export function currentHolder(handle: Readonly<Record<string, JsonValue>> = {}, since: Date = new Date()): RunHolder {
  return holderOf({ driver: "local", host: hostname(), bootId: thisBoot(), ...handle, pid: process.pid, since: since.toISOString() })!;
}
