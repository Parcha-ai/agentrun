// run.json: the run's status, generation, holder, heartbeat and seal, written by the instance that holds the
// claim with write-to-temp, fsync, rename, and read by the supervisor (over the S3 API or a local mount). It is a hint
// for the supervisor, never the source of truth: the store is. Any error writing it is a fence. The instance writes it
// through its claim directory (`ClaimDir`), never by path, so a write cannot land under a mountpoint whose mount is gone.
import { constants, readFileSync } from "node:fs";
import { open, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { FencedError, ownWriteFenced, PdaError } from "./errors.ts";

export const RUN_JSON = "run.json";
/** The temporary file every write goes through; renamed over `run.json` once it is fsynced. */
export const RUN_JSON_TEMP = "run.json.tmp";

/** Heartbeat period: the instance rewrites `heartbeatAt` this often. */
export const DEFAULT_HEARTBEAT_MS = 20_000;
/** A lease whose last heartbeat is older than this has expired; the supervisor may revoke. */
export const DEFAULT_LEASE_EXPIRY_MS = 90_000;
/** The instance fences itself this long before its lease expires, on its own monotonic clock. */
export const DEFAULT_LEASE_MARGIN_MS = 15_000;

export const RUN_STATUSES = ["running", "sleeping", "paused", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The incarnation that wrote the record: the host driver's name and enough to find and stop the process. Fields beyond
 * the five named here are the host driver's own handle (a unit name, a mountpoint), kept as written so the supervisor
 * can hand them back to the driver.
 */
export interface RunHolder {
  readonly driver: string;
  readonly host: string;
  /** `/proc/sys/kernel/random/boot_id`; null where the platform has none. */
  readonly bootId: string | null;
  readonly pid: number;
  /** When this incarnation claimed the run (ISO 8601). */
  readonly since: string;
  readonly [field: string]: JsonValue;
}

export interface RunRecord {
  readonly run: string;
  readonly status: RunStatus;
  /** Incremented on every claim, so a log line or receipt can name the incarnation that wrote it. */
  readonly generation: number;
  /** The store's last committed sequence at a clean release; null while running and after a crash. */
  readonly sealedSeq: number | null;
  /** When a `sleeping` run should be started again (ISO 8601); null otherwise. */
  readonly wakeAt: string | null;
  readonly holder: RunHolder | null;
  /** Wall-clock time at which the last successful heartbeat write started (ISO 8601). */
  readonly heartbeatAt: string | null;
  /** Wall-clock time of the last status transition (ISO 8601). */
  readonly updatedAt: string;
  readonly detail: JsonValue | null;
}

/** `run.json` is missing a field, has one of the wrong type, or is not JSON. Exit 65 (EX_DATAERR): a restart cannot fix it. */
export class RunRecordError extends PdaError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("RUN_JSON_INVALID", message, { cause: options.cause, exitCode: 65 });
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

/**
 * Parse and validate the text of a `run.json`. Unknown fields are ignored, so a newer writer stays readable. Throws
 * RunRecordError on anything else. This is the reader the supervisor uses on the bytes it gets over the S3 API.
 */
export function parseRunRecord(text: string): RunRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new RunRecordError("run.json is not JSON", { cause });
  }
  const r = value as Partial<Record<keyof RunRecord, unknown>> | null;
  if (typeof r !== "object" || r === null || Array.isArray(r)) throw new RunRecordError("run.json is not an object");
  if (typeof r.run !== "string" || r.run === "") throw new RunRecordError("run must be a non-empty string");
  if (!(RUN_STATUSES as readonly unknown[]).includes(r.status)) throw new RunRecordError(`status ${JSON.stringify(r.status)} is not one of ${RUN_STATUSES.join(", ")}`);
  if (!isCount(r.generation)) throw new RunRecordError("generation must be a non-negative integer");
  if (r.sealedSeq !== null && !isCount(r.sealedSeq)) throw new RunRecordError("sealedSeq must be a non-negative integer or null");
  if (r.wakeAt !== null && !isInstant(r.wakeAt)) throw new RunRecordError("wakeAt must be an ISO 8601 instant or null");
  if (r.heartbeatAt !== null && !isInstant(r.heartbeatAt)) throw new RunRecordError("heartbeatAt must be an ISO 8601 instant or null");
  if (!isInstant(r.updatedAt)) throw new RunRecordError("updatedAt must be an ISO 8601 instant");
  return {
    run: r.run,
    status: r.status as RunStatus,
    generation: r.generation,
    sealedSeq: r.sealedSeq as number | null,
    wakeAt: r.wakeAt as string | null,
    holder: holderOf(r.holder),
    heartbeatAt: r.heartbeatAt as string | null,
    updatedAt: r.updatedAt,
    detail: r.detail === undefined ? null : (r.detail as JsonValue),
  };
}

/** The `run.json` under a run's root on a local mount (or in a claim directory), or undefined when the run has none yet. */
export async function readRunRecord(root: string | ClaimDir): Promise<RunRecord | undefined> {
  let text: string;
  try {
    text = await readFile(join(typeof root === "string" ? root : root.at, RUN_JSON), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
  return parseRunRecord(text);
}

/**
 * True while the record's last heartbeat is younger than `expiryMs` on the reader's clock. The supervisor allows for
 * clock skew between hosts inside the expiry.
 */
export function isLeaseFresh(record: RunRecord, nowMs: number = Date.now(), expiryMs: number = DEFAULT_LEASE_EXPIRY_MS): boolean {
  if (record.heartbeatAt === null) return false;
  return nowMs - Date.parse(record.heartbeatAt) < expiryMs;
}

/**
 * Writes `text` as `<root>/run.json` durably and atomically; replaceable for fault injection. Once `signal` is aborted
 * the write must not publish: an instance that is fenced never renames a record over `run.json`.
 */
export type PersistRecord = (root: string, text: string, signal?: AbortSignal) => Promise<void>;

/** Write to `run.json.tmp`, fsync it, rename it over `run.json`, fsync the directory. */
export const persistRecord: PersistRecord = async (root, text, signal) => {
  const temp = join(root, RUN_JSON_TEMP);
  const file = await open(temp, "w", 0o644);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  // The rename is the commit point: a write that began before a fence must not publish after it. Nothing else runs
  // between this check and the rename's dispatch.
  if (signal?.aborted) {
    await rm(temp, { force: true }).catch(() => undefined);
    signal.throwIfAborted();
  }
  await rename(temp, join(root, RUN_JSON));
  const dir = await open(root, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
};

/**
 * Write `record`; any error at all is a fence (`ownWriteFenced`), whatever its errno. Into a claim directory, the write
 * goes through the open directory, after `assertMounted` (its CLAIM_UNMOUNTED fence is rethrown as is). `signal` as in
 * `PersistRecord`.
 */
export async function writeRunRecord(root: string | ClaimDir, record: RunRecord, persist: PersistRecord = persistRecord, signal?: AbortSignal): Promise<void> {
  try {
    if (typeof root !== "string") await root.assertMounted();
    await persist(typeof root === "string" ? root : root.at, `${JSON.stringify(record, null, 2)}\n`, signal);
  } catch (error) {
    if (error instanceof FencedError && error.code === CLAIM_UNMOUNTED) throw error;
    throw ownWriteFenced(join(typeof root === "string" ? root : root.root, RUN_JSON), error);
  }
}

// ---- the claim directory ----------------------------------------------------------------------------------------------

/** The FencedError code of a claim root that is no longer the mount the instance opened (unmounted, lazily or not). */
export const CLAIM_UNMOUNTED = "CLAIM_UNMOUNTED";
/** The file system type of an Archil mount in the mount table. */
export const ARCHIL_FSTYPE = "fuse.archil";

/**
 * A run root held open as a directory for the life of the instance. `at` is `/proc/self/fd/<n>`, a path the kernel
 * resolves through the open directory and never through the root's path (Node has no openat; the magic link stands in
 * for it): a file made, written or renamed under `at` is in the directory opened at acquire, or the call fails (ENOTCONN
 * once the FUSE daemon is gone). It never lands on the local disk under a mountpoint whose mount went away.
 */
export interface ClaimDir {
  /** The root's path, as the claim names it. */
  readonly root: string;
  /** `/proc/self/fd/<n>`. Throws once closed: the number may then name another file. */
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
   * The root must be the mount point of a mount of this type whose device is the opened directory's (default
   * `fuse.archil`). Null skips the mount table: a run root on a local directory, for tests.
   */
  readonly fstype?: string | null;
  /** Default `/proc/self/mountinfo`. */
  readonly mountinfo?: string;
}

/** `major:minor` of a device number, as `/proc/self/mountinfo` writes it (glibc's encoding). */
export function deviceName(dev: bigint): string {
  const major = ((dev & 0xfff00n) >> 8n) | ((dev & 0xfffff00000000000n) >> 32n);
  const minor = (dev & 0xffn) | ((dev & 0xffffff00000n) >> 12n);
  return `${major}:${minor}`;
}

const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/** Every mount at `mountpoint` in a mountinfo table: its device and its type. */
function mountsAt(table: string, mountpoint: string): Array<{ dev: string; fstype: string }> {
  const found: Array<{ dev: string; fstype: string }> = [];
  for (const line of table.split("\n")) {
    const f = line.split(" ");
    const separator = f.indexOf("-", 6);
    if (separator < 0 || f.length < separator + 2) continue;
    if (unescapeMount(f[4]!) === mountpoint) found.push({ dev: f[2]!, fstype: f[separator + 1]! });
  }
  return found;
}

const unmounted = (message: string, cause?: unknown) => new FencedError(message, { code: CLAIM_UNMOUNTED, cause });

/**
 * Open `root` as the claim's directory. With an `fstype` (default `fuse.archil`), the mount table must list a mount of
 * that type at `root` on the device of the directory just opened; otherwise, and when the root cannot be opened, a
 * FencedError CLAIM_UNMOUNTED (exit 75).
 */
export async function openClaimDir(root: string, options: OpenClaimDirOptions = {}): Promise<ClaimDir> {
  const fstype = options.fstype === undefined ? ARCHIL_FSTYPE : options.fstype;
  let handle: FileHandle;
  try {
    handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    throw unmounted(`opening the claim root ${root} failed: ${(error as Error).message}`, error);
  }
  let held: { dev: bigint; ino: bigint };
  try {
    held = await handle.stat({ bigint: true });
    if (fstype !== null) {
      const table = await readFile(options.mountinfo ?? "/proc/self/mountinfo", "utf8");
      const dev = deviceName(held.dev);
      const mounts = mountsAt(table, root);
      if (!mounts.some((m) => m.fstype === fstype && m.dev === dev)) {
        const listed = mounts.map((m) => `${m.fstype} on ${m.dev}`).join(", ") || "nothing";
        throw unmounted(`the claim root ${root} is on device ${dev}, not a ${fstype} mount there (the mount table lists ${listed})`);
      }
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error instanceof FencedError ? error : unmounted(`checking the claim root ${root} failed: ${(error as Error).message}`, error);
  }
  const at = `/proc/self/fd/${handle.fd}`;
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
      const [byPath, inDir] = await Promise.all([statOf(join(root, name)), statOf(join(at, name))]);
      if (inDir.dev !== held.dev) throw unmounted(`${name} in the claim directory is on device ${deviceName(inDir.dev)}, not the claim's ${deviceName(held.dev)}`);
      same(join(root, name), byPath, inDir);
    },
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

function bootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * This process as a holder: the host driver's `handle` (default driver `local`, this machine's host name and boot id)
 * with this process's pid and `since`. A handle whose named fields have the wrong type is refused (RunRecordError).
 */
export function currentHolder(handle: Readonly<Record<string, JsonValue>> = {}, since: Date = new Date()): RunHolder {
  return holderOf({ driver: "local", host: hostname(), bootId: bootId(), ...handle, pid: process.pid, since: since.toISOString() })!;
}
