// The run lifecycle in two layers. `openRunLease` is the claim's lifecycle without a store or a Harness: the
// claim, the owner lock, `run.json` with its heartbeat, the self-fence (a timer and a watchdog thread), the seal, the
// fence and the release; an app that owns its own Harness and store connections uses it directly. `openDurableRun`
// builds the whole run on it: the store, the seal check, pi's Harness, resume. A fence reported by the store, the claim,
// a write of the run's own files or the lapsed lease kills the run's commands and ends the instance (exit 75). Nothing
// is retried. The lease writes its own files through the claim directory (`ClaimDir`), never by path.
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import type { HarnessOptions, Seq, Storage, StorageWrite, ToolRegistration } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { acquire, type AcquireOptions, type ArchilHost, type Claim, type RunRef } from "./claim.ts";
import { archilEnv } from "./env.ts";
import { EXIT_FENCED, FencedError, HeldError, ownWriteFenced, PdaError } from "./errors.ts";
import { openArchilStore, type ArchilStore, type Profile } from "./store.ts";
import { LeaseWatchdog } from "./watchdog.ts";
import {
  currentHolder,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_EXPIRY_MS,
  DEFAULT_LEASE_MARGIN_MS,
  openClaimDir,
  persistRecord,
  readRunRecord,
  RUN_JSON,
  RunRecordError,
  writeRunRecord,
  type ClaimDir,
  type PersistRecord,
  type RunHolder,
  type RunRecord,
  type RunStatus,
} from "./status.ts";

/** The same-host owner lock under the run's root. */
export const OWNER_LOCK = "owner.lock";
/** pi's store under the claim's `store/` directory. */
export const STORE_FILE = "run.sqlite";
/** EX_DATAERR: the run's data refuses to open (a store behind its seal, an unreadable `run.json`); a restart cannot help. */
export const EXIT_DATAERR = 65;
/** EX_SOFTWARE: this package cannot read the head of pi's store (pi's schema moved); a restart cannot help. */
export const EXIT_SOFTWARE = 70;

export type RunErrorCode = "INVALID_ARGUMENT" | "STORE_HEAD_UNREADABLE" | "RUN_RELEASED";

/**
 * Bad options, a call on a released run, or a store whose head cannot be read (STORE_HEAD_UNREADABLE: the run is marked
 * `failed` and released, exit 70).
 */
export class RunError extends PdaError {
  constructor(code: RunErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, { cause: options.cause, exitCode: code === "STORE_HEAD_UNREADABLE" ? EXIT_SOFTWARE : 1 });
  }
}

/**
 * The store's last committed sequence is below the `sealedSeq` the last clean release wrote: an acknowledged commit is
 * missing. The run is refused before pi commits anything, and marked `failed` in `run.json`. Exit 65.
 */
export class StoreBehindSealError extends PdaError {
  readonly sealedSeq: number;
  /** The store's last committed sequence. */
  readonly head: number;
  constructor(file: string, sealedSeq: number, head: number) {
    super("STORE_BEHIND_SEAL", `store ${file} is at sequence ${head}, behind its seal at ${sealedSeq}`, { exitCode: EXIT_DATAERR });
    this.sealedSeq = sealedSeq;
    this.head = head;
  }
}

/**
 * The self-fence rule: the last heartbeat that succeeded started longer ago than the lease expiry minus its margin. `by`
 * names who saw it: the main thread's timer, or the watchdog thread (which had already killed the commands).
 */
export class LeaseLapsedError extends FencedError {
  readonly sinceMs: number;
  readonly by: "timer" | "watchdog";
  constructor(sinceMs: number, limitMs: number, by: "timer" | "watchdog" = "timer") {
    super(`the last successful heartbeat started ${Math.round(sinceMs)} ms ago, past the ${limitMs} ms self-fence (seen by the ${by})`, { code: "LEASE_LAPSED" });
    this.sinceMs = sinceMs;
    this.by = by;
  }
}

/** What the run needs of its environment: pi's `env` option plus a way to kill every command it started. */
export type RunEnv = NonNullable<HarnessOptions["env"]> & { cleanup(context: Context): Promise<void> };

export interface LeaseOptions {
  /** Heartbeat period; default 20 s. */
  readonly heartbeatMs?: number;
  /** The lease the supervisor grants; default 90 s. */
  readonly expiryMs?: number;
  /** The instance fences itself at `expiryMs - marginMs` after the last successful heartbeat started; default 15 s. */
  readonly marginMs?: number;
  /** How often the self-fence timer looks; default 1 s. */
  readonly checkMs?: number;
}

export type OpenStep = "acquire" | "owner-lock" | "run.json" | "heartbeat" | "layout" | "store" | "seal" | "harness" | "live" | "resume";
export type ReleaseStep = "close" | "cleanup" | "barrier" | "seal" | "unlock" | "unmount";

export interface OpenRunLeaseOptions {
  /** The mount token from the host driver (reusable, 24 h); travels only on the archil wrapper's stdin, never in an environment. */
  readonly mountToken: string;
  /** Default /mnt/archil. */
  readonly mountRoot?: string;
  /** Mount with `--force`: the takeover fallback when the supervisor could not revoke. */
  readonly force?: boolean;
  readonly host?: ArchilHost;
  /**
   * The host driver's handle, written as run.json's `holder` with this process's pid and `since` added; `driver`
   * defaults to `local`, `host` and `bootId` to this machine's. The supervisor hands it back to the driver to stop it.
   */
  readonly holder?: Readonly<Record<string, JsonValue>>;
  readonly lease?: LeaseOptions;
  /**
   * The instance runs in a cgroup of its own (a systemd unit, a container). When the lease lapses, the watchdog then
   * kills every other process in that cgroup too, beyond the instance's direct children and their process groups.
   * Leave it off in a shared cgroup (a login session): its other processes are not the run's.
   */
  readonly ownCgroup?: boolean;
  /**
   * Kills every command the app started (pi starts each as its own process group, so the instance's own group does not
   * reach them). Runs first on any fence, before `onFenced`, and as the first step of `release()`. Default: nothing.
   */
  readonly cleanup?: (context: Context) => Promise<void>;
  /** Called once, after `cleanup`, on any fence. Default (and if it throws): a line on stderr, exit 75. */
  readonly onFenced?: (error: FencedError) => void;
  readonly context?: Context;
  /** Each lifecycle step as it completes, with its duration. */
  readonly onStep?: (step: OpenStep | ReleaseStep, ms: number) => void;
  /** Replaceable for tests: how the claim is taken (default `acquire`). */
  readonly acquire?: (options: AcquireOptions) => Promise<Claim>;
  /** Replaceable for fault injection: how `run.json` is written (default `persistRecord`). */
  readonly persist?: PersistRecord;
  /**
   * Replaceable for tests: how the claim's root is held open (default `openClaimDir(root)`, which requires the root to be
   * the mount point of an Archil mount). A run root on a local directory passes `(root) => openClaimDir(root, { fstype: null })`.
   */
  readonly claimDir?: (root: string) => Promise<ClaimDir>;
  /** Replaceable for tests: the monotonic clock the self-fence measures with, in ms (default `performance.now`). */
  readonly clock?: () => number;
}

export interface OpenDurableRunOptions<Tool extends ToolRegistration = ToolRegistration> extends Omit<OpenRunLeaseOptions, "cleanup"> {
  /** Default `exclusive`. */
  readonly profile?: Profile;
  /** pi's Harness options; the registry holds every extension before the Harness opens (recovered tasks need them). */
  readonly harness: Omit<HarnessOptions<Tool>, "env">;
  /** The run's environment, built on the claim; default `archilEnv(claim)`. Its `cleanup` is the lease's. */
  readonly env?: (claim: Claim) => RunEnv;
  /** Wraps the raw database inside the store's fence (instrumentation, fault injection). */
  readonly decorateStore?: (database: SqliteDatabase) => SqliteDatabase;
}

/** The claim as the app sees it: paths, the fenced flag, and a barrier whose failure fences the run. */
export interface RunClaim {
  readonly ref: RunRef;
  readonly disk: string;
  readonly root: string;
  readonly work: string;
  readonly store: string;
  readonly fenced: boolean;
  /** `archil sync` of the mount: the workspace is durable before a result commits and before a terminal status; a failure fences the run. */
  barrier(): Promise<void>;
}

/**
 * The claim's lifecycle for an app that owns its store and Harness (`openDurableRun` without the store and the Harness). Open
 * order, all done by `openRunLease`: acquire and verify the claim, take the owner lock, write `run.json` (`running`,
 * generation + 1, this holder, a heartbeat, the previous seal kept), start the heartbeat and the self-fence (a timer and
 * a watchdog thread), create `store/`, `work/` and `tmp/`. The app then opens its store, calls `checkSeal` before
 * anything commits, opens its Harness over `observe(storage)`, and calls `live()`. Once fenced, every member that
 * writes rejects with the first fence; nothing is retried.
 */
export interface RunLease {
  readonly ref: RunRef;
  readonly claim: RunClaim;
  /** This incarnation's generation in `run.json` (the previous one + 1). */
  readonly generation: number;
  /** `run.json` as last written. */
  readonly record: RunRecord;
  /** The seal the previous incarnation's clean release wrote; null on a first run and after a crash. */
  readonly sealedSeq: number | null;
  readonly fenced: boolean;
  /**
   * The seal check on the app's store, before anything commits: the store's head (`storeHead`) below
   * `sealedSeq` is refused with StoreBehindSealError (65), and a head that cannot be read with RunError
   * STORE_HEAD_UNREADABLE (70). Either way `run.json` is marked `failed` first, keeping the seal, and the app then calls
   * `abandon` (never `release`, which would seal the lower head).
   */
  checkSeal(store: StoreHeadSource): Promise<void>;
  /**
   * `storage` reporting to the lease: every resolved commit's sequence counts toward the seal `release()` writes; a
   * commit is refused once the watchdog found the lease lapsed, and one stuck meanwhile ends in the fence; a FencedError
   * from a commit fences the lease. Wrap every Storage a Harness of the run opens over.
   */
  observe(storage: Storage): Storage;
  /** The store is open and checked: clear the seal in `run.json` (a heartbeat write). */
  live(): Promise<void>;
  /**
   * Fence the run, once: refuse every later `run.json` write (one in flight never renames), stop the timers and the
   * watchdog, mark the claim fenced, all synchronously; then `cleanup`, then `onFenced`. Returns the first fence. The
   * app's store facade calls it from its `onFenced`.
   */
  fence(error: FencedError): FencedError;
  /** Resolves once a fence's cleanup and `onFenced` ran (when `onFenced` returns). */
  fenceSettled(): Promise<void>;
  /** Write a status transition. `done` and `failed` run the barrier first, so a terminal status never names workspace files that are not durable. */
  setStatus(status: RunStatus, detail?: JsonValue | null, options?: { readonly wakeAt?: string | null }): Promise<void>;
  /** `archil sync` of the mount: the workspace is durable before a result commits and before a terminal status; a failure fences. */
  barrier(): Promise<void>;
  /**
   * After the app closed every Harness and store connection: `cleanup`, barrier, seal `run.json` with the store's last
   * sequence and the final status (`running` seals as `paused`), release the owner lock, unmount. Heartbeats continue
   * until the seal and the self-fence past it, so a release that hangs still ends in exit 75. A failed barrier is a
   * fence: nothing is sealed.
   */
  release(): Promise<void>;
  /**
   * Undo an open that failed after `openRunLease` (the app's store, the seal, its Harness): nothing is sealed. A fence
   * goes to the fence path. Otherwise the timers stop, pending writes settle, `close` (the app closing what it opened)
   * runs, the owner lock is released and the claim unmounted, except after a HeldError, whose mount another process on
   * this host holds.
   */
  abandon(error: unknown, close?: () => Promise<void>): Promise<void>;
}

export interface DurableRun {
  readonly ref: RunRef;
  /** pi-durable's Harness, resumed. */
  readonly harness: Harness;
  readonly claim: RunClaim;
  readonly env: RunEnv;
  readonly store: ArchilStore;
  readonly generation: number;
  /** `run.json` as last written. */
  readonly record: RunRecord;
  readonly fenced: boolean;
  /** Write a status transition. `done` and `failed` run the barrier first, so a terminal status never names workspace files that are not durable. */
  setStatus(status: RunStatus, detail?: JsonValue | null, options?: { readonly wakeAt?: string | null }): Promise<void>;
  /**
   * Close the Harness (running work is aborted with no outcome recorded, so the next open reports it interrupted),
   * kill the run's commands, barrier, seal `run.json` with the store's last sequence and the final status (`running`
   * seals as `paused`), release the owner lock, unmount. A rejecting close or barrier is a fence: nothing is sealed.
   */
  release(): Promise<void>;
}

// ---- the owner lock ---------------------------------------------------------------------------------------------------

export interface OwnerLock {
  readonly file: string;
  /** Drop the lock. An error is a fence (`ownWriteFenced`). */
  release(): void;
}

/** Locks this process holds. A collected DatabaseSync closes its file, which would drop the lock without a word. */
const heldLocks = new Set<DatabaseSync>();

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const isBusy = (error: unknown): boolean => {
  const errcode = (error as { errcode?: unknown }).errcode;
  return typeof errcode === "number" && [SQLITE_BUSY, SQLITE_LOCKED].includes(errcode & 0xff);
};

/**
 * Take the run's same-host owner lock for the life of this process. Node has no flock(2), so the lock is
 * SQLite's exclusive POSIX lock on `<root>/owner.lock` (`locking_mode = EXCLUSIVE`, then `BEGIN EXCLUSIVE`), which the
 * kernel drops when the process dies, however it dies. The journal stays in memory, so `owner.lock` is the only file
 * the lock makes. Another process holding it is HeldError("owner-lock") (76); any other error is a fence, since the
 * file is the claim's.
 *
 * Only this function may open `owner.lock` in the process: a POSIX lock is dropped when any descriptor the process holds
 * on the file is closed, so a stray open and close elsewhere would silently release it.
 */
export function takeOwnerLock(root: string): OwnerLock {
  const file = join(root, OWNER_LOCK);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { timeout: 0 });
  } catch (error) {
    throw ownWriteFenced(file, error);
  }
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("PRAGMA journal_mode = MEMORY");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.close();
    } catch {
      // The lock was never ours; the refusal is the error to report.
    }
    if (isBusy(error)) throw new HeldError("owner-lock", `${file} is held by another process on this host`, { cause: error });
    throw ownWriteFenced(file, error);
  }
  heldLocks.add(db);
  return {
    file,
    release() {
      if (!heldLocks.delete(db)) return;
      try {
        db.close();
      } catch (error) {
        throw ownWriteFenced(file, error);
      }
    },
  };
}

// ---- the seal ---------------------------------------------------------------------------------------------------------

/** What `storeHead` reads: an ArchilStore, or any connection to a pi store with the file it opened. */
export interface StoreHeadSource {
  readonly database: Pick<SqliteExecutor, "get">;
  readonly file: string;
}

/**
 * The last sequence the store committed: the one read of pi's internal schema in this package. pi-durable 1.0.4's
 * public `Storage` has no head query, and the seal check must run before `Harness.open` can commit (its recovery commit
 * would reuse a lost sequence number). pi's SqliteStorage gives each commit `durable_metadata.next_seq` and stores the
 * successor in the same transaction, so the head is `next_seq - 1`. The query only reads. A store without that table,
 * row or column fails closed (STORE_HEAD_UNREADABLE), so a pi whose schema moved never skips the check silently;
 * a unit test pins the read to the sequence pi's commits return.
 *
 * `database` is the store's fence-aware facade (`FencedDatabase`), which turns an I/O-class error into a fence; through
 * a raw connection such an error would read as STORE_HEAD_UNREADABLE.
 */
export async function storeHead(store: StoreHeadSource): Promise<number> {
  let row: { next_seq?: unknown } | undefined;
  try {
    row = await store.database.get<{ next_seq?: unknown }>("SELECT next_seq FROM durable_metadata WHERE singleton = 1");
  } catch (error) {
    if (error instanceof FencedError) throw error;
    throw new RunError("STORE_HEAD_UNREADABLE", `cannot read the head of ${store.file}`, { cause: error });
  }
  const next = typeof row?.next_seq === "bigint" ? Number(row.next_seq) : row?.next_seq;
  if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 1) {
    throw new RunError("STORE_HEAD_UNREADABLE", `${store.file} has no usable durable_metadata.next_seq (${JSON.stringify(row ?? null)})`);
  }
  return next - 1;
}

/**
 * `storage` with `before` run ahead of every commit (it may throw to refuse it), every resolved commit's sequence
 * reported to `after` and every rejected commit's error to `failed`; everything else delegates unchanged.
 */
function observeCommits(storage: Storage, hooks: { before(): void; after(seq: Seq): void; failed(error: unknown): void }): Storage {
  return new Proxy(storage, {
    get(target, key) {
      if (key === "commit") {
        return async (writes: readonly StorageWrite[], context: Context) => {
          hooks.before();
          let seq: Seq;
          try {
            seq = await target.commit(writes, context);
          } catch (error) {
            hooks.failed(error);
            throw error;
          }
          hooks.after(seq);
          return seq;
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ---- the lease --------------------------------------------------------------------------------------------------------

const asFenced = (error: unknown, what: string): FencedError =>
  error instanceof FencedError ? error : new FencedError(`${what} failed, so the claim cannot be trusted`, { cause: error });

function exitFenced(error: FencedError): void {
  process.stderr.write(`pi-durable-archil: fenced (${error.code}): ${error.message}\n`);
  process.exit(EXIT_FENCED);
}

type Step = <T>(name: OpenStep | ReleaseStep, run: () => T | Promise<T>) => Promise<T>;

function stepper(onStep: OpenRunLeaseOptions["onStep"]): Step {
  return async (name, run) => {
    const t0 = performance.now();
    const value = await run();
    onStep?.(name, performance.now() - t0);
    return value;
  };
}

function leaseOf(options: LeaseOptions = {}): Required<LeaseOptions> {
  const lease = {
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    expiryMs: options.expiryMs ?? DEFAULT_LEASE_EXPIRY_MS,
    marginMs: options.marginMs ?? DEFAULT_LEASE_MARGIN_MS,
    checkMs: options.checkMs ?? 1000,
  };
  const limit = lease.expiryMs - lease.marginMs;
  if (!(lease.heartbeatMs > 0 && lease.checkMs > 0 && lease.marginMs >= 0 && limit > lease.heartbeatMs)) {
    throw new RunError("INVALID_ARGUMENT", `lease ${JSON.stringify(lease)}: the self-fence (expiry minus margin) must exceed the heartbeat period`);
  }
  return lease;
}

const noCleanup = async (): Promise<void> => undefined;

class Lease implements RunLease {
  readonly ref: RunRef;
  readonly claim: RunClaim;
  /** The claim itself, for a layer that builds on the lease (`openDurableRun` builds the env on it). */
  readonly rawClaim: Claim;
  #options: OpenRunLeaseOptions;
  #context: Context;
  #lease: Required<LeaseOptions>;
  #clock: () => number;
  #persist: PersistRecord;
  #cleanup: (context: Context) => Promise<void>;
  #onFenced: (error: FencedError) => void;
  #openDir: (root: string) => Promise<ClaimDir>;
  /** The claim's root held open: every write of the lease's own files goes through it. */
  #dir: ClaimDir | undefined;
  #dirClosed: Promise<void> | undefined;
  #lock: OwnerLock | undefined;
  #previous: RunRecord | undefined;
  #record: RunRecord | undefined;
  #lastSeq = 0;
  #fence: { error: FencedError; done: Promise<void> } | undefined;
  /** Aborted by the fence, synchronously: a `run.json` write still in flight then refuses to rename. */
  #fencing = new AbortController();
  #releasing: Promise<void> | undefined;
  #released = false;
  #writes: Promise<unknown> = Promise.resolve();
  #beating = false;
  #lastBeatStart = 0;
  #lastBeatNs = 0n;
  #heartbeat: NodeJS.Timeout | undefined;
  #leaseCheck: NodeJS.Timeout | undefined;
  #watchdog: LeaseWatchdog | undefined;

  constructor(ref: RunRef, claim: Claim, options: OpenRunLeaseOptions, context: Context) {
    this.ref = ref;
    this.rawClaim = claim;
    this.#options = options;
    this.#context = context;
    this.#lease = leaseOf(options.lease);
    this.#clock = options.clock ?? (() => performance.now());
    this.#persist = options.persist ?? persistRecord;
    this.#cleanup = options.cleanup ?? noCleanup;
    this.#onFenced = options.onFenced ?? exitFenced;
    this.#openDir = options.claimDir ?? ((root) => openClaimDir(root));
    const lease = this;
    this.claim = {
      ref: claim.ref,
      disk: claim.disk,
      root: claim.root,
      work: claim.work,
      store: claim.store,
      get fenced() {
        return lease.fenced;
      },
      barrier: () => lease.barrier(),
    };
  }

  get record(): RunRecord {
    return this.#record!;
  }

  get generation(): number {
    return this.#record!.generation;
  }

  get sealedSeq(): number | null {
    return this.#previous?.sealedSeq ?? null;
  }

  get fenced(): boolean {
    return this.#fence !== undefined;
  }

  /** The first fence, once fenced. */
  get fencedBy(): FencedError | undefined {
    return this.#fence?.error;
  }

  /** True once `release()` began. */
  get releasing(): boolean {
    return this.#releasing !== undefined || this.#released;
  }

  fence(error: FencedError): FencedError {
    if (this.#fence) return this.#fence.error;
    const fence = { error, done: Promise.resolve() };
    this.#fence = fence;
    this.#fencing.abort(error);
    this.#stopTimers();
    this.rawClaim.markFenced(error);
    fence.done = this.#cleanup(this.#context)
      .catch(() => undefined)
      .then(() => this.#onFenced(error))
      .catch(() => exitFenced(error));
    void fence.done.then(() => this.#closeDir());
    return error;
  }

  fenceSettled(): Promise<void> {
    return this.#fence?.done ?? Promise.resolve();
  }

  /**
   * The order after the claim. `run.json` is written (`running`, generation + 1, this holder, a heartbeat) and the
   * heartbeat starts right after the owner lock, before the store and the Harness open, so a supervisor never sees the
   * previous incarnation's stale heartbeat on a live claim. That first write keeps the previous `sealedSeq`, which the
   * seal check still needs; `live()` clears it once the store is open.
   */
  async open(step: Step, holder: RunHolder): Promise<void> {
    const claim = this.rawClaim;
    // SQLite resolves symbolic links in a file name, `/proc/self/fd/<n>` included, so `owner.lock` is the one file opened
    // by path: right after the mount check, and the file it names must then be the one in the claim directory.
    this.#lock = await step("owner-lock", async () => {
      const dir = (this.#dir = await this.#openDir(claim.root));
      await dir.assertMounted();
      const lock = takeOwnerLock(claim.root);
      try {
        await dir.assertSame(OWNER_LOCK);
      } catch (error) {
        try {
          lock.release();
        } catch {
          // The lock is not the claim's; the failed check is the fence to report.
        }
        throw error;
      }
      return lock;
    });
    const previous = await this.#readPrevious();
    this.#previous = previous;
    this.#lastSeq = previous?.sealedSeq ?? 0;
    await step("run.json", async () => {
      const now = new Date().toISOString();
      this.#noteBeat(await this.#write(() => ({
        run: this.ref.id,
        status: "running",
        generation: (previous?.generation ?? 0) + 1,
        sealedSeq: previous?.sealedSeq ?? null,
        wakeAt: null,
        holder,
        heartbeatAt: now,
        updatedAt: now,
        detail: null,
      })));
    });
    // Two self-fences: a timer on this thread, and a watchdog thread for when this thread is stuck in a FUSE request.
    await step("heartbeat", () => {
      this.#heartbeat = setInterval(() => this.#beat(), this.#lease.heartbeatMs).unref();
      this.#leaseCheck = setInterval(() => this.#checkLease(), this.#lease.checkMs).unref();
      this.#watchdog = new LeaseWatchdog({
        limitMs: this.#lease.expiryMs - this.#lease.marginMs,
        checkMs: this.#lease.checkMs,
        beatNs: this.#lastBeatNs,
        ownCgroup: this.#options.ownCgroup === true,
      });
    });
    await step("layout", async () => {
      for (const dir of [claim.store, claim.work, join(claim.root, "tmp")]) {
        const under = relative(claim.root, dir);
        if (under === "" || under.startsWith("..") || isAbsolute(under)) throw new RunError("INVALID_ARGUMENT", `${dir} is not under the claim root ${claim.root}`);
        try {
          await mkdir(join(this.#dir!.at, under), { recursive: true });
        } catch (error) {
          throw ownWriteFenced(dir, error);
        }
      }
    });
  }

  async checkSeal(store: StoreHeadSource): Promise<void> {
    const sealed = this.sealedSeq;
    let head: number;
    try {
      head = await storeHead(store);
    } catch (error) {
      if (error instanceof RunError) await this.#markFailed({ code: error.code, sealedSeq: sealed, reason: error.message });
      throw error;
    }
    this.#lastSeq = Math.max(this.#lastSeq, head);
    if (sealed === null || head >= sealed) return;
    const refusal = new StoreBehindSealError(store.file, sealed, head);
    await this.#markFailed({ code: refusal.code, sealedSeq: sealed, head });
    throw refusal;
  }

  observe(storage: Storage): Storage {
    return observeCommits(storage, {
      before: () => {
        const lapse = this.#watchdogLapse();
        if (lapse) throw this.fence(lapse);
      },
      after: (seq) => {
        this.#lastSeq = Math.max(this.#lastSeq, seq);
        const lapse = this.#watchdogLapse();
        if (lapse) this.fence(lapse);
      },
      failed: (error) => {
        if (error instanceof FencedError) this.fence(error);
      },
    });
  }

  async live(): Promise<void> {
    this.#assertUsable();
    const now = new Date().toISOString();
    this.#noteBeat(await this.#write((current) => ({ ...current!, sealedSeq: null, heartbeatAt: now })));
  }

  async abandon(error: unknown, close?: () => Promise<void>): Promise<void> {
    this.#stopTimers();
    if (this.#fence || error instanceof FencedError) {
      this.fence(this.#fence?.error ?? (error as FencedError));
      await this.fenceSettled();
      return;
    }
    try {
      await this.#writes;
      await close?.();
      this.#lock?.release();
      await this.#closeDir();
      if (!(error instanceof HeldError)) await this.rawClaim.release();
    } catch (cleanupError) {
      if (cleanupError instanceof FencedError) {
        this.fence(cleanupError);
        await this.fenceSettled();
      }
    }
  }

  async setStatus(status: RunStatus, detail: JsonValue | null = null, options: { readonly wakeAt?: string | null } = {}): Promise<void> {
    this.#assertUsable();
    if (status === "done" || status === "failed") await this.barrier();
    const now = new Date().toISOString();
    await this.#write((current) => ({ ...current!, status, detail, wakeAt: options.wakeAt ?? null, updatedAt: now }));
  }

  async barrier(): Promise<void> {
    if (this.#fence) throw this.#fence.error;
    try {
      await this.rawClaim.barrier();
    } catch (error) {
      if (error instanceof FencedError) throw this.fence(error);
      throw error;
    }
  }

  release(): Promise<void> {
    if (this.#released) return Promise.resolve();
    if (this.#fence) return Promise.reject(this.#fence.error);
    this.#releasing ??= this.#release();
    return this.#releasing;
  }

  async #release(): Promise<void> {
    const step = stepper(this.#options.onStep);
    await step("cleanup", () => this.#cleanup(this.#context));
    await step("barrier", () => this.barrier());
    clearInterval(this.#heartbeat);
    await step("seal", () => {
      const now = new Date().toISOString();
      return this.#write((current) => ({
        ...current!,
        status: current!.status === "running" ? "paused" : current!.status,
        sealedSeq: this.#lastSeq,
        updatedAt: now,
      }));
    });
    this.#stopTimers();
    await step("unlock", () => {
      try {
        this.#lock!.release();
      } catch (error) {
        throw this.fence(asFenced(error, `releasing ${OWNER_LOCK}`));
      }
    });
    await step("unmount", async () => {
      await this.#closeDir();
      try {
        await this.rawClaim.release();
      } catch (error) {
        if (error instanceof FencedError) throw this.fence(error);
        throw error;
      }
    });
    this.#released = true;
  }

  async #readPrevious(): Promise<RunRecord | undefined> {
    let previous: RunRecord | undefined;
    try {
      previous = await readRunRecord(this.#dir!);
    } catch (error) {
      if (error instanceof RunRecordError) throw error;
      throw asFenced(error, `reading ${join(this.rawClaim.root, RUN_JSON)}`);
    }
    if (previous !== undefined && previous.run !== this.ref.id) {
      throw new RunRecordError(`${join(this.rawClaim.root, RUN_JSON)} names run ${JSON.stringify(previous.run)}, not ${JSON.stringify(this.ref.id)}`);
    }
    return previous;
  }

  /** `run.json` becomes `failed` with `detail`; the seal the record carries is kept as evidence. */
  async #markFailed(detail: JsonValue): Promise<void> {
    const now = new Date().toISOString();
    await this.#write((current) => ({ ...current!, status: "failed", updatedAt: now, detail }));
  }

  /** Serialize writes of `run.json`. Resolves with the clock readings when this write started; a failure fences. */
  #write(change: (current: RunRecord | undefined) => RunRecord): Promise<{ started: number; startedNs: bigint }> {
    const next = this.#writes.then(async () => {
      if (this.#fence) throw this.#fence.error;
      const record = change(this.#record);
      const started = this.#clock();
      const startedNs = process.hrtime.bigint();
      try {
        const dir = this.#dir;
        if (dir === undefined) throw new FencedError(`the claim directory of ${this.rawClaim.root} is closed`);
        await writeRunRecord(dir, record, this.#persist, this.#fencing.signal);
      } catch (error) {
        throw this.fence(asFenced(error, `writing ${RUN_JSON}`));
      }
      this.#record = record;
      return { started, startedNs };
    });
    this.#writes = next.catch(() => undefined);
    return next;
  }

  /**
   * Close the claim directory once no write can still address it: a closed descriptor's number may be reused, and
   * `/proc/self/fd/<n>` would then name another file. An open directory also keeps the mount busy, so this runs before
   * the unmount.
   */
  #closeDir(): Promise<void> {
    this.#dirClosed ??= (async () => {
      await this.#writes;
      const dir = this.#dir;
      this.#dir = undefined;
      await dir?.close().catch(() => undefined);
    })();
    return this.#dirClosed;
  }

  #beat(): void {
    if (this.#beating || this.#fence || this.#released) return;
    this.#beating = true;
    this.#write((current) => ({ ...current!, heartbeatAt: new Date().toISOString() }))
      .then((started) => this.#noteBeat(started))
      .catch(() => undefined)
      .finally(() => (this.#beating = false));
  }

  /** A heartbeat-class write (the first, the one in `live()`, each heartbeat) succeeded. */
  #noteBeat(write: { started: number; startedNs: bigint }): void {
    this.#lastBeatStart = Math.max(this.#lastBeatStart, write.started);
    if (write.startedNs > this.#lastBeatNs) this.#lastBeatNs = write.startedNs;
    this.#watchdog?.beat(write.startedNs);
  }

  #watchdogLapse(): LeaseLapsedError | undefined {
    const since = this.#watchdog?.lapsedAfterMs;
    return since === undefined ? undefined : new LeaseLapsedError(since, this.#lease.expiryMs - this.#lease.marginMs, "watchdog");
  }

  #checkLease(): void {
    if (this.#fence) return;
    const lapse = this.#watchdogLapse();
    if (lapse) {
      this.fence(lapse);
      return;
    }
    const since = this.#clock() - this.#lastBeatStart;
    const limit = this.#lease.expiryMs - this.#lease.marginMs;
    if (since > limit) this.fence(new LeaseLapsedError(since, limit));
  }

  #stopTimers(): void {
    clearInterval(this.#heartbeat);
    clearInterval(this.#leaseCheck);
    this.#heartbeat = this.#leaseCheck = undefined;
    this.#watchdog?.stop();
    this.#watchdog = undefined;
  }

  #assertUsable(): void {
    if (this.#fence) throw this.#fence.error;
    if (this.#released || this.#releasing) throw new RunError("RUN_RELEASED", `run ${this.ref.id} is released`);
  }
}

async function openLease(ref: RunRef, options: OpenRunLeaseOptions, step: Step): Promise<Lease> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  leaseOf(options.lease);
  let holder: RunHolder;
  try {
    holder = currentHolder(options.holder);
  } catch (error) {
    throw new RunError("INVALID_ARGUMENT", `holder ${JSON.stringify(options.holder)}: ${(error as Error).message}`, { cause: error });
  }
  const claim = await step("acquire", () =>
    (options.acquire ?? acquire)({
      ref,
      token: options.mountToken,
      ...(options.mountRoot === undefined ? {} : { mountRoot: options.mountRoot }),
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.host === undefined ? {} : { host: options.host }),
    }),
  );
  const lease = new Lease(ref, claim, options, context);
  try {
    await lease.open(step, holder);
  } catch (error) {
    await lease.abandon(error);
    throw error;
  }
  return lease;
}

/**
 * Open the claim's lifecycle for run `ref` (see `RunLease`): acquire and verify the claim, take the owner lock, write
 * `run.json` and start the heartbeat and the self-fence, create `store/`, `work/` and `tmp/`. Errors are typed as for
 * `openDurableRun`: HeldError (76), FencedError (75, also passed to `onFenced`), RunRecordError (65), RunError
 * INVALID_ARGUMENT before any claim.
 */
export async function openRunLease(ref: RunRef, options: OpenRunLeaseOptions): Promise<RunLease> {
  return openLease(ref, options, stepper(options.onStep));
}

// ---- the run ----------------------------------------------------------------------------------------------------------

class Run implements DurableRun {
  readonly ref: RunRef;
  readonly env: RunEnv;
  #lease: Lease;
  #options: OpenDurableRunOptions<ToolRegistration>;
  #context: Context;
  #store: ArchilStore | undefined;
  #harness: Harness | undefined;
  #releasing: Promise<void> | undefined;
  #released = false;

  constructor(lease: Lease, env: RunEnv, options: OpenDurableRunOptions<ToolRegistration>, context: Context) {
    this.ref = lease.ref;
    this.#lease = lease;
    this.env = env;
    this.#options = options;
    this.#context = context;
  }

  get harness(): Harness {
    return this.#harness!;
  }

  get store(): ArchilStore {
    return this.#store!;
  }

  get claim(): RunClaim {
    return this.#lease.claim;
  }

  get record(): RunRecord {
    return this.#lease.record;
  }

  get generation(): number {
    return this.#lease.generation;
  }

  get fenced(): boolean {
    return this.#lease.fenced;
  }

  /** The store, the seal check, pi's Harness over the observed storage, the seal cleared, resume. */
  async open(step: Step): Promise<void> {
    const lease = this.#lease;
    const file = join(lease.rawClaim.store, STORE_FILE);
    this.#store = await step("store", () =>
      openArchilStore(file, this.#options.profile ?? "exclusive", {
        onFenced: (error) => void lease.fence(error),
        ...(this.#options.decorateStore === undefined ? {} : { decorate: this.#options.decorateStore }),
      }),
    );
    // Both refusals here are terminal: the run is marked `failed`, keeping its seal, so the supervisor stops on it.
    await step("seal", () => lease.checkSeal(this.#store!));
    const storage = lease.observe(this.#store.storage);
    this.#harness = await step("harness", () => Harness.open(storage, { ...this.#options.harness, env: this.env }, this.#context));
    await step("live", () => lease.live());
    await step("resume", () => this.#harness!.resume());
  }

  /** Undo a failed open: close what this layer opened, then the lease's own undo. */
  abandon(error: unknown): Promise<void> {
    return this.#lease.abandon(error, async () => {
      if (this.#harness) await this.#harness.close(this.#context);
      else if (this.#store) await this.#store.storage.close(this.#context);
    });
  }

  async setStatus(status: RunStatus, detail: JsonValue | null = null, options: { readonly wakeAt?: string | null } = {}): Promise<void> {
    if (!this.#lease.fenced && (this.#released || this.#releasing)) throw new RunError("RUN_RELEASED", `run ${this.ref.id} is released`);
    await this.#lease.setStatus(status, detail, options);
  }

  release(): Promise<void> {
    if (this.#released) return Promise.resolve();
    if (this.#lease.fenced) return Promise.reject(this.#lease.fencedBy);
    this.#releasing ??= this.#release();
    return this.#releasing;
  }

  async #release(): Promise<void> {
    const step = stepper(this.#options.onStep);
    // Closing first aborts running work without recording an outcome, so the next open reports it interrupted; the
    // lease then kills the commands, barriers, seals and unmounts.
    await step("close", async () => {
      try {
        await this.#harness!.close(this.#context);
      } catch (error) {
        throw this.#lease.fence(asFenced(error, "closing the Harness"));
      }
    });
    await this.#lease.release();
    this.#released = true;
  }
}

/**
 * Open run `ref` on this host: the lease (`openRunLease`: claim, owner lock, `run.json`, heartbeat and
 * self-fence, layout), then the store, the seal check before anything commits, pi's Harness with the app's registry,
 * the seal cleared in `run.json`, resume.
 *
 * Errors are typed: HeldError (76) when another client, another process on this host or another connection holds the
 * run; FencedError (75) when the claim cannot be trusted (also passed to `onFenced`); StoreBehindSealError (65) and
 * RunError STORE_HEAD_UNREADABLE (70), each after marking the run `failed` and releasing the claim.
 */
export async function openDurableRun<Tool extends ToolRegistration = ToolRegistration>(
  ref: RunRef,
  options: OpenDurableRunOptions<Tool>,
): Promise<DurableRun> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const step = stepper(options.onStep);
  let env: RunEnv | undefined;
  const lease = await openLease(ref, { ...options, context, cleanup: (c) => env?.cleanup(c) ?? Promise.resolve() }, step);
  env = (options.env ?? ((c: Claim) => archilEnv(c)))(lease.rawClaim);
  const run = new Run(lease, env, options as unknown as OpenDurableRunOptions<ToolRegistration>, context);
  try {
    await run.open(step);
  } catch (error) {
    await run.abandon(error);
    throw error;
  }
  return run;
}
