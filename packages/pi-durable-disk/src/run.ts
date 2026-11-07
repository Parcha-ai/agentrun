// The run's lifecycle. `openDurableRun` opens a run on a local directory (`localRun`): the claim directory held open, the
// store's own lock tried before anything is reaped, the layout, the reap of what a killed incarnation's commands left
// running, a new run's seed, then the store, pi's Harness and resume. The run's record (its status, `detail`, `wakeAt`
// and generation) lives in its own store, in RUN_STATUS_TABLE, written by its process alone; the store's exclusive lock
// keeps a second writer out. A fence reported by the store, the claim or a write of the run's own files kills the run's
// commands and ends the instance (exit 75). Nothing is retried.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import type { HarnessOptions, Seq, Storage, StorageWrite, ToolRegistration } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import type { AcquireOptions, Claim, RunRef } from "./claim.ts";
import { reapOrRefuse } from "./commands.ts";
import { archilEnv } from "./env.ts";
import { BoxUnavailableError, EXIT_DATAERR, EXIT_FENCED, EXIT_SOFTWARE, FencedError, HeldError, ownWriteFenced, PdaError } from "./errors.ts";
import { BARRIER, syncNow, type SyncTarget } from "./barriers.ts";
import { openArchilStore, type ArchilStore, type Profile, type Synchronous } from "./store.ts";
import { currentHolder, openClaimDir, parseRunRecord, readStoreRecord, RUN_STATUS_TABLE, RunRecordError, type BoxMode, type ClaimDir, type RunHolder, type RunRecord, type RunStatus } from "./status.ts";

/** pi's store under the claim's `store/` directory. */
export const STORE_FILE = "run.sqlite";
export { RUN_STATUS_TABLE };
export { EXIT_DATAERR, EXIT_SOFTWARE };

export type RunErrorCode = "INVALID_ARGUMENT" | "STORE_HEAD_UNREADABLE" | "RUN_RELEASED" | "RELEASE_ORDER";

/**
 * Bad options, a call on a released run, `setStatus()` or `release()` after the Harness was closed outside `release()`
 * (RELEASE_ORDER), or a store whose head cannot be read (STORE_HEAD_UNREADABLE: the run is marked `failed` and released,
 * exit 70).
 */
export class RunError extends PdaError {
  constructor(code: RunErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, { cause: options.cause, exitCode: code === "STORE_HEAD_UNREADABLE" ? EXIT_SOFTWARE : 1 });
  }
}

/** What the run needs of its environment: pi's `env` option plus a way to kill every command it started. */
export type RunEnv = NonNullable<HarnessOptions["env"]> & { cleanup(context: Context): Promise<void> };

export type OpenStep = "acquire" | "claim-dir" | "layout" | "commands" | "after-claim" | "seed" | "store" | "harness" | "record" | "before-resume" | "resume";

/** Where a new run's seed writes: the claim's root, the store file the Harness will open, and the workspace. */
export interface RunSeedDir {
  readonly root: string;
  readonly storePath: string;
  readonly workDir: string;
}

/**
 * What a new run starts with, written before anything can see the run: its store file (`storePath`, a SQLite database
 * the Harness then opens) and files in its workspace. It runs inside the run's first claim, after `store/`, `work/` and
 * `tmp/` exist and `afterClaim` has run, and before the store opens. It never runs on a later open (one that finds the
 * run's record in the store). If it throws (or its process dies) the open fails and nothing is published, so the next open seeds again: it
 * must overwrite what an earlier attempt wrote. A connection it opens on `storePath` must be closed before it returns.
 */
export type RunSeed = (dir: RunSeedDir) => void | Promise<void>;
export type ReleaseStep = "record" | "close" | "cleanup" | "barrier" | "unmount";

export interface OpenRunOptions {
  /**
   * The host's handle, written as the record's `holder` with this process's pid and `since` added; `driver` defaults to
   * `local`, `host` and `bootId` to this machine's.
   */
  readonly holder?: Readonly<Record<string, JsonValue>>;
  /**
   * The box this open's run actually runs in, as the host resolved it for this launch (serve's capabilities.box.mode):
   * recorded as the record's `box.mode` exactly as given, never probed, so the next open can tell a switch from the record.
   * Whatever the switch, the commands reap runs on this host, outside any box, before anything of this incarnation runs,
   * and holds the open while a process the last incarnation's commands left is alive. Whether a switch may proceed at all
   * (a run leaving its box) is the host's to refuse before it opens. Absent: nothing is recorded.
   */
  readonly boxMode?: BoxMode;
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
  /** How the claim is taken: `localRun(root)`'s, a directory on this machine. */
  readonly acquire: (options: AcquireOptions) => Promise<Claim>;
  /** Replaceable for tests: how the claim's root is held open (default `openClaimDir(root)`). */
  readonly claimDir?: (root: string) => Promise<ClaimDir>;
  /**
   * A new run's starting state (`RunSeed`): run on the open that finds no record in the store, before the store opens;
   * what it wrote is made durable (the claim's barrier) before the store opens.
   */
  readonly seed?: RunSeed;
  /**
   * The run's claim epoch, held by its host on a record of its own (agentrun-serve's run row, whose epoch is the whole
   * lock): the record's generation. Its host keeps any other holder off the run (it kills a live one before it claims).
   * Without it, the generation is the previous record's plus 1, read from the store once this open holds its lock: for a
   * caller on one machine with no host epoch. Either way the store's own exclusive lock keeps a second writer out.
   */
  readonly epoch?: number;
}

export interface OpenDurableRunOptions<Tool extends ToolRegistration = ToolRegistration> extends Omit<OpenRunOptions, "cleanup"> {
  /** Default `exclusive`. */
  readonly profile?: Profile;
  /**
   * The store's close leaves its WAL in place (store.ts `keepWal`): for a run's own process, which then ends by
   * process.exit, so the release checkpoints nothing and whoever takes the run back next checkpoints it. Default off.
   */
  readonly keepWal?: boolean;
  /**
   * pi's Harness options; the registry holds every extension before the Harness opens (recovered tasks need them).
   * Required, here or from `afterClaim`.
   */
  readonly harness?: Omit<HarnessOptions<Tool>, "env">;
  /**
   * Awaited once the claim is held (the run's directory held open, its store free, `store/`, `work/` and `tmp/` made,
   * what a killed incarnation's commands left running reaped) and before the store opens, with the claim's paths: what
   * it returns (`harness`, `beforeResume`, a new run's `seed`) goes into the open, over what these options give; the seed
   * runs right after it, on a new run only. For code that must run on the live directory, as an app module's factory
   * does under the CLI. A rejection fails the open with the store as the open found it; the claim is released.
   */
  readonly afterClaim?: (claim: Pick<Claim, "ref" | "root" | "work" | "store">) => Promise<AfterClaim<Tool>>;
  /** The run's environment, built on the claim; default `archilEnv(claim)`. Its `cleanup` is the run's. */
  readonly env?: (claim: Claim) => RunEnv;
  /** Wraps the raw database inside the store's fence (instrumentation, fault injection). */
  readonly decorateStore?: (database: SqliteDatabase) => SqliteDatabase;
  /** The store's `synchronous` level; default the journal's (JOURNAL_SYNCHRONOUS in store.ts). */
  readonly synchronous?: Synchronous;
  /**
   * Awaited once the Harness is open (its registry installed) and the run is live, before the Harness resumes: no
   * resumed task takes a step until it settles, and what it admits (a submission, a write) is committed before anything
   * a resumed task's steps commit. A host reconciles here what a resumed tool depends on (a browser, a mount). A rejection
   * fails the open as any step does (`before-resume`), and the claim is released.
   */
  readonly beforeResume?: (run: BeforeResume) => void | Promise<void>;
}

/** What `afterClaim` gives the open: the Harness options, the `beforeResume` hook and a new run's seed, when it holds them. */
export interface AfterClaim<Tool extends ToolRegistration = ToolRegistration> {
  readonly harness?: Omit<HarnessOptions<Tool>, "env">;
  readonly beforeResume?: (run: BeforeResume) => void | Promise<void>;
  /** A new run's seed, over the options' `seed`; ignored on an open that finds the run's record (a resume). */
  readonly seed?: RunSeed;
}

/** openDurableRun's afterClaim, as the claim's open runs it: what it returns for the claim is the seed. */
type AfterClaimHook = (claim: Claim) => Promise<{ readonly seed?: RunSeed }>;

/**
 * What `beforeResume` sees: the open Harness, not yet resumed, the open's context, the incarnation it belongs to, and the
 * store the Harness was opened over with its head (a recorder snapshots every document at `head` here).
 */
export interface BeforeResume {
  readonly harness: Harness;
  readonly context: Context;
  readonly generation: number;
  /** This incarnation's record, which the open has already written in the store (`running`, this holder, `detail` null). */
  readonly record: RunRecord;
  /**
   * The record as the previous incarnation left it in the store: how the run was left. After a park it is `sleeping` with
   * its `wakeAt` and `detail`; after a planned stop, `paused` or `done` with the `detail` it set; after a crash, `running`
   * with the dead holder. Null on a new run's first open.
   */
  readonly previous: RunRecord | null;
  readonly claim: RunClaim;
  /**
   * The run's store as a barrier takes it (`syncNow`, barriers.ts): for a host that guards the effects a resumed task
   * sends, before its own onOpen. For the barrier only; the store's writes are the Harness's.
   */
  readonly syncTarget: SyncTarget;
  /** The store the Harness was opened over, read-only: four reads on an object of their own, and no way to a write. */
  readonly storage: StoreReads;
  /**
   * The store's last committed sequence once the Harness is open, read just before the hook runs. Until the hook commits
   * something, the store's current state is its state at `head`: a document that keeps no history (`latest`, and session
   * and task documents) reads only at "current", a `rewindable` one at `head` too.
   */
  readonly head: Seq;
}

/** The reads of a store that `beforeResume` gets. */
export type StoreReads = Pick<Storage, "scanConversations" | "scanTasks" | "scanDocuments" | "document">;

/**
 * `storage`'s four reads on a frozen object that holds nothing else: no `commit` or `mintId` on it, and no reference to
 * `storage` a cast could reach.
 */
function storeReads(storage: Storage): StoreReads {
  return Object.freeze({
    scanConversations: (...args: Parameters<Storage["scanConversations"]>) => storage.scanConversations(...args),
    scanTasks: (...args: Parameters<Storage["scanTasks"]>) => storage.scanTasks(...args),
    scanDocuments: (...args: Parameters<Storage["scanDocuments"]>) => storage.scanDocuments(...args),
    document: (...args: Parameters<Storage["document"]>) => storage.document(...args),
  });
}

/** The claim as the app sees it: paths, the fenced flag, and a barrier whose failure fences the run. */
export interface RunClaim {
  readonly ref: RunRef;
  readonly disk: string;
  readonly root: string;
  readonly work: string;
  readonly store: string;
  readonly fenced: boolean;
  /** The claim's barrier, before a result commits and before a terminal status: it refuses once the claim is fenced (a failure fences the run). On a local directory it syncs nothing beyond the store's own commits. */
  barrier(): Promise<void>;
}

export interface DurableRun {
  readonly ref: RunRef;
  /** pi-durable's Harness, resumed. */
  readonly harness: Harness;
  readonly claim: RunClaim;
  readonly env: RunEnv;
  readonly store: ArchilStore;
  readonly generation: number;
  /** The run's record as last written in its store. */
  readonly record: RunRecord;
  readonly fenced: boolean;
  /** True once `release()` began: the Harness is closed, the status is final, and the instance has nothing left to serve. */
  readonly releasing: boolean;
  /** Write a status transition. `done` and `failed` run the barrier first, so a terminal status never names workspace files that are not durable. */
  setStatus(status: RunStatus, detail?: JsonValue | null, options?: { readonly wakeAt?: string | null }): Promise<void>;
  /**
   * Close the Harness (running work is aborted with no outcome recorded, so the next open reports it interrupted),
   * kill the run's commands, barrier, let go of the claim directory. The release's record (a run still `running` is
   * `paused`) is written in the store before the close. A rejecting close or barrier is a fence.
   */
  release(): Promise<void>;
}

// ---- the store's head and its lock ----------------------------------------------------------------------------------

/** What `storeHead` reads: an ArchilStore, or any connection to a pi store with the file it opened. */
export interface StoreHeadSource {
  readonly database: Pick<SqliteExecutor, "get">;
  readonly file: string;
}

/**
 * The last sequence the store committed: the one read of pi's internal schema in this package. pi-durable's public
 * `Storage` has no head query (1.0.4 and 1.1.0). pi's SqliteStorage gives each commit `durable_metadata.next_seq`
 * and stores the successor in the same transaction, so the head is `next_seq - 1`. The query only reads. A store
 * without that table, row or column fails closed (STORE_HEAD_UNREADABLE); a unit test pins the read to the sequence
 * pi's commits return.
 *
 * `database` is the store's fence-aware facade (`FencedDatabase`), which turns an I/O-class error into a fence; through
 * a raw connection such an error would read as STORE_HEAD_UNREADABLE.
 */
/**
 * Refuses (HeldError `store`, STORE_BUSY) while another connection holds run store `file` as a run's process does (an
 * exclusive locking mode): its read meets the holder's lock. A store that is free is taken for that read and let go;
 * its close checkpoints what a previous incarnation left in its WAL, as the open that follows may. Read-write: in an
 * exclusive locking mode a read takes a write lock, which a read-only descriptor cannot. No file: nothing holds it.
 * A local directory's store only.
 */
export function assertStoreFree(file: string): void {
  if (!existsSync(file)) return;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { timeout: 0 });
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.prepare("SELECT count(*) FROM sqlite_schema").get();
  } catch (error) {
    // SQLITE_BUSY (5), or SQLITE_LOCKED (6): another connection holds it. Anything else is the open's own error.
    const code = Number((error as { errcode?: number }).errcode) & 0xff;
    if (code === 5 || code === 6) throw new HeldError("store", `${file} is held by another connection`, { cause: error });
    throw error;
  } finally {
    db?.close();
  }
}

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
 * reported to `after`, every rejected commit's error to `failed`, and its close to `closing`; everything else delegates
 * unchanged.
 */
function observeCommits(storage: Storage, hooks: { before(): void; after(seq: Seq): void; failed(error: unknown): void; closing?(): void }): Storage {
  return new Proxy(storage, {
    get(target, key) {
      if (key === "close" && hooks.closing) {
        return (context: Context) => {
          hooks.closing!();
          return target.close(context);
        };
      }
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

// ---- the claim's open -------------------------------------------------------------------------------------------------

const asFenced = (error: unknown, what: string): FencedError =>
  error instanceof FencedError ? error : new FencedError(`${what} failed, so the claim cannot be trusted`, { cause: error });

/** The default `onFenced`: a line on stderr, exit 75. */
export function exitFenced(error: FencedError): void {
  process.stderr.write(`pi-durable-disk: fenced (${error.code}): ${error.message}\n`);
  process.exit(EXIT_FENCED);
}

type Step = <T>(name: OpenStep | ReleaseStep, run: () => T | Promise<T>) => Promise<T>;

function stepper(onStep: OpenRunOptions["onStep"]): Step {
  return async (name, run) => {
    const t0 = performance.now();
    const value = await run();
    onStep?.(name, performance.now() - t0);
    return value;
  };
}

const noCleanup = async (): Promise<void> => undefined;

/**
 * The claim's lifecycle under the run: the claim directory held open, the store's lock tried, the layout, the commands
 * reap and a new run's seed; then the record (kept in memory here, written in the store by `Run`), the fence, the
 * barrier and the release.
 */
class Lease {
  readonly ref: RunRef;
  readonly claim: RunClaim;
  /** The claim itself, for a layer that builds on it (`openDurableRun` builds the env on it). */
  readonly rawClaim: Claim;
  #options: OpenRunOptions;
  #context: Context;
  #cleanup: (context: Context) => Promise<void>;
  #onFenced: (error: FencedError) => void;
  #openDir: (root: string) => Promise<ClaimDir>;
  /** The claim's root held open: the layout is made through it. */
  #dir: ClaimDir | undefined;
  #dirClosed: Promise<void> | undefined;
  #previous: RunRecord | undefined;
  #record: RunRecord | undefined;
  #fence: { error: FencedError; done: Promise<void> } | undefined;
  #releasing: Promise<void> | undefined;
  #released = false;
  /** The host's claim epoch (`epoch`), or undefined: the generation is then the previous record's plus 1. */
  readonly epoch: number | undefined;

  constructor(ref: RunRef, claim: Claim, options: OpenRunOptions, context: Context) {
    this.epoch = options.epoch;
    this.ref = ref;
    this.rawClaim = claim;
    this.#options = options;
    this.#context = context;
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

  get previous(): RunRecord | null {
    return this.#previous ?? null;
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
   * The claim directory held open and the store's lock tried, before a previous incarnation's commands are reaped, so an
   * open refused by it kills nothing of the run that holds the store; then `store/`, `work/` and `tmp/`, the commands
   * reap, `afterClaim` and a new run's seed. This incarnation's record (`running`, this holder) is written in the store
   * once it is open (`Run`).
   */
  async open(step: Step, holder: RunHolder, afterClaim?: AfterClaimHook): Promise<void> {
    const claim = this.rawClaim;
    await step("claim-dir", async () => {
      const dir = (this.#dir = await this.#openDir(claim.root));
      await dir.assertMounted();
      assertStoreFree(join(claim.store, STORE_FILE));
    });
    await step("layout", () => this.#layout());
    // A claim that records its commands (a local run's): end what a killed incarnation left running, before any code of
    // this incarnation runs, so no command of it still writes in work/ once the run resumes. A process of it that outlives
    // its SIGKILL refuses the open (HeldError, 76): the run never resumes beside it, and its record stays for the next open.
    const commands = claim.commands;
    if (commands !== undefined) await step("commands", () => reapOrRefuse(commands));
    const given = afterClaim ? await step("after-claim", () => afterClaim(claim)) : undefined;
    // A new run (no record in its store yet): its seed writes what it starts with before the store opens. afterClaim's
    // seed goes over the options'. A seed that failed, or whose process died, left no record, so the next open seeds again.
    const seed = given?.seed ?? this.#options.seed;
    if (seed !== undefined && (await readStoreRecord(join(claim.store, STORE_FILE))) === null) {
      await step("seed", async () => {
        await this.#dir!.assertMounted();
        await seed({ root: claim.root, storePath: join(claim.store, STORE_FILE), workDir: claim.work });
        await this.#dir!.assertMounted();
        await claim.barrier();
      });
    }
    const now = new Date().toISOString();
    this.#record = { run: this.ref.id, status: "running", generation: this.epoch ?? 0, wakeAt: null, holder, updatedAt: now, detail: null, ...(this.#options.boxMode === undefined ? {} : { box: { mode: this.#options.boxMode } }) };
  }

  /** `store/`, `work/` and `tmp/`, made through the held claim directory. */
  async #layout(): Promise<void> {
    const claim = this.rawClaim;
    for (const dir of [claim.store, claim.work, join(claim.root, "tmp")]) {
      const under = relative(claim.root, dir);
      if (under === "" || under.startsWith("..") || isAbsolute(under)) throw new RunError("INVALID_ARGUMENT", `${dir} is not under the claim root ${claim.root}`);
      try {
        await mkdir(join(this.#dir!.at, under), { recursive: true });
      } catch (error) {
        throw ownWriteFenced(dir, error);
      }
    }
  }

  /** `storage` reporting to the claim: a commit is refused once the run is fenced, and a FencedError from one fences it. */
  observe(storage: Storage, closing?: () => void): Storage {
    return observeCommits(storage, {
      ...(closing ? { closing } : {}),
      before: () => {
        if (this.#fence) throw this.#fence.error;
      },
      after: () => undefined,
      failed: (error) => {
        if (error instanceof FencedError) this.fence(error);
      },
    });
  }

  async abandon(error: unknown, close?: () => Promise<void>): Promise<void> {
    if (this.#fence || error instanceof FencedError) {
      this.fence(this.#fence?.error ?? (error as FencedError));
      await this.fenceSettled();
      return;
    }
    try {
      await close?.();
      await this.#closeDir();
      await this.rawClaim.release();
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
    this.#record = { ...this.#record!, status, detail, wakeAt: options.wakeAt ?? null, updatedAt: new Date().toISOString() };
  }

  /**
   * The record the previous incarnation left in the store, read once it is open under its lock. Without a host epoch,
   * this incarnation's generation is that record's plus 1. A record naming another run is refused (RunRecordError), so
   * an open with the wrong id never resumes that run's work or writes its own id over it.
   */
  fromStore(previous: RunRecord | undefined): void {
    if (previous !== undefined && previous.run !== this.ref.id) {
      throw new RunRecordError(`the record in ${join(this.rawClaim.store, STORE_FILE)} names run ${JSON.stringify(previous.run)}, not ${JSON.stringify(this.ref.id)}`);
    }
    this.#previous = previous;
    if (this.epoch === undefined) this.#record = { ...this.#record!, generation: (previous?.generation ?? 0) + 1 };
  }

  /** The record a release leaves (a run still `running` is `paused`), before the store closes. */
  releasedRecord(): RunRecord {
    const current = this.#record!;
    this.#record = { ...current, status: current.status === "running" ? "paused" : current.status, updatedAt: new Date().toISOString() };
    return this.#record;
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

  /** Close the claim directory once (a closed descriptor's number may be reused, and `/proc/self/fd/<n>` would then name another file). */
  #closeDir(): Promise<void> {
    this.#dirClosed ??= (async () => {
      const dir = this.#dir;
      this.#dir = undefined;
      await dir?.close().catch(() => undefined);
    })();
    return this.#dirClosed;
  }

  #assertUsable(): void {
    if (this.#fence) throw this.#fence.error;
    if (this.#released || this.#releasing) throw new RunError("RUN_RELEASED", `run ${this.ref.id} is released`);
  }
}

async function openLease(ref: RunRef, options: OpenRunOptions, step: Step, afterClaim?: AfterClaimHook): Promise<Lease> {
  // No box to run in: nothing of the run is claimed, run or written (a host that launched it so has a bug; serve holds it).
  if (options.boxMode === "unavailable") throw new BoxUnavailableError();
  const context = options.context ?? BACKGROUND_CONTEXT;
  let holder: RunHolder;
  try {
    holder = currentHolder(options.holder);
  } catch (error) {
    throw new RunError("INVALID_ARGUMENT", `holder ${JSON.stringify(options.holder)}: ${(error as Error).message}`, { cause: error });
  }
  // A run is a local directory's: its claim comes from localRun(root).
  if (typeof options.acquire !== "function") throw new RunError("INVALID_ARGUMENT", "a run is a local directory: pass localRun(root)");
  const claim = await step("acquire", () => options.acquire({ ref }));
  const lease = new Lease(ref, claim, options, context);
  try {
    await lease.open(step, holder, afterClaim);
  } catch (error) {
    await lease.abandon(error);
    throw error;
  }
  return lease;
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
  /** The Harness closed the store outside release(): its record has nowhere to go. */
  #closedFirst = false;

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

  /** The store, pi's Harness over the observed storage, the record, resume. */
  async open(step: Step): Promise<void> {
    const lease = this.#lease;
    const file = join(lease.rawClaim.store, STORE_FILE);
    // The run's record lives in its store. The previous incarnation's is read under the store's lock before pi's
    // Harness opens over it, so a malformed record, or one naming another run, is refused before anything of pi runs there.
    await step("store", async () => {
      this.#store = await openArchilStore(file, this.#options.profile ?? "exclusive", {
        onFenced: (error) => void lease.fence(error),
        ...(this.#options.keepWal ? { keepWal: true } : {}),
        ...(this.#options.decorateStore === undefined ? {} : { decorate: this.#options.decorateStore }),
        ...(this.#options.synchronous === undefined ? {} : { synchronous: this.#options.synchronous }),
      });
      const database = this.#store.database;
      await database.exec(`CREATE TABLE IF NOT EXISTS ${RUN_STATUS_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)`);
      const row = await database.get<{ record: string }>(`SELECT record FROM ${RUN_STATUS_TABLE} WHERE id = 1`);
      lease.fromStore(row ? parseRunRecord(row.record) : undefined);
    });
    const storage = lease.observe(this.#store!.storage, () => {
      if (this.#releasing === undefined) this.#closedFirst = true;
    });
    // openDurableRun refused an open without Harness options (here or from afterClaim) before this runs.
    this.#harness = await step("harness", () => Harness.open(storage, { ...this.#options.harness!, env: this.env }, this.#context));
    // This incarnation's record, written under the store's lock.
    await step("record", () => this.#keepStatus(lease.record));
    const before = this.#options.beforeResume;
    if (before) {
      // The storage the Harness was opened over (the claim observes its commits), and its head now: nothing commits
      // between the open and the hook, since the Harness has not resumed.
      await step("before-resume", async () => {
        const head = (await storeHead(this.#store!)) as Seq;
        await before({ harness: this.#harness!, context: this.#context, generation: lease.generation, record: lease.record, previous: lease.previous, claim: lease.claim, syncTarget: this.#store!, storage: storeReads(storage), head });
      });
    }
    await step("resume", () => this.#harness!.resume());
  }

  /** Undo a failed open: close what this layer opened, then the claim's own undo. */
  abandon(error: unknown): Promise<void> {
    return this.#lease.abandon(error, async () => {
      if (this.#harness) await this.#harness.close(this.#context);
      else if (this.#store) await this.#store.storage.close(this.#context);
    });
  }

  get releasing(): boolean {
    return this.#releasing !== undefined || this.#released;
  }

  async setStatus(status: RunStatus, detail: JsonValue | null = null, options: { readonly wakeAt?: string | null } = {}): Promise<void> {
    if (!this.#lease.fenced && (this.#released || this.#releasing)) throw new RunError("RUN_RELEASED", `run ${this.ref.id} is released`);
    this.#assertOrder("setStatus()");
    // What the run committed is durable before a status says where it stands: the status is a commit of the store,
    // synced after it. A fenced run's store takes no write: a fenced run syncs nothing.
    await this.#lease.setStatus(status, detail, options);
    await this.#keepStatus(this.#lease.record);
    if (!this.#lease.fenced) await syncNow(this.#store!, BARRIER.runStatus);
  }

  /**
   * The record is written in the store, and closing the Harness closes the store: a Harness closed outside release()
   * leaves the record nowhere to go. Refused in words (RELEASE_ORDER), with nothing fenced and the record as the open
   * wrote it, as after a crash.
   */
  #assertOrder(what: string): void {
    if (!this.#closedFirst) return;
    throw new RunError(
      "RELEASE_ORDER",
      `${what} before closing the Harness: run ${this.ref.id}'s Harness was closed first, and its store with it, so its record cannot be written. close the Harness only through release(), which writes the record and then closes it`,
    );
  }

  /** The run's record, written in its store (its one row of RUN_STATUS_TABLE); a failed write fences. */
  async #keepStatus(record: RunRecord): Promise<void> {
    try {
      await this.#store!.database.run(`INSERT INTO ${RUN_STATUS_TABLE} (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record`, JSON.stringify(record));
    } catch (error) {
      throw this.#lease.fence(asFenced(error, `writing ${RUN_STATUS_TABLE}`));
    }
  }

  release(): Promise<void> {
    if (this.#released) return Promise.resolve();
    if (this.#lease.fenced) return Promise.reject(this.#lease.fencedBy);
    try {
      this.#assertOrder("release()");
    } catch (error) {
      return Promise.reject(error);
    }
    this.#releasing ??= this.#release();
    return this.#releasing;
  }

  async #release(): Promise<void> {
    const step = stepper(this.#options.onStep);
    // The release's record goes into the store while it is still open: a run still running is paused.
    await step("record", () => this.#keepStatus(this.#lease.releasedRecord()));
    // Closing first aborts running work without recording an outcome, so the next open reports it interrupted; the
    // claim then kills the commands, barriers and lets go of its directory.
    await step("close", async () => {
      try {
        await this.#harness!.close(this.#context);
        // A close that checkpoints synced the WAL; one that keeps it (keepWal) left it as it was: what the run committed,
        // its release record among it, is durable before the claim is let go.
        if (this.#options.keepWal) await syncNow(this.#store!, BARRIER.runRelease);
      } catch (error) {
        throw this.#lease.fence(asFenced(error, "closing the Harness"));
      }
    });
    await this.#lease.release();
    this.#released = true;
  }
}

/**
 * Open run `ref` on this host: the claim (`localRun`'s: the claim directory, the store's lock tried, the layout, the
 * commands reap, then `afterClaim` and a new run's seed), then the store, pi's Harness with the app's registry, the
 * run's record in the store, resume.
 *
 * Errors are typed: HeldError (76) when another process holds the run's store, or a process a killed incarnation's
 * commands left will not die; FencedError (75) when the claim cannot be trusted (also passed to `onFenced`); RunError
 * STORE_HEAD_UNREADABLE (70) when the store's head cannot be read; RunRecordError (65) when the store's record is
 * malformed or names another run.
 */
export async function openDurableRun<Tool extends ToolRegistration = ToolRegistration>(
  ref: RunRef,
  options: OpenDurableRunOptions<Tool>,
): Promise<DurableRun> {
  if (!options.harness && !options.afterClaim) throw new RunError("INVALID_ARGUMENT", "openDurableRun needs pi's Harness options, from its options or from afterClaim");
  const context = options.context ?? BACKGROUND_CONTEXT;
  const step = stepper(options.onStep);
  let env: RunEnv | undefined;
  let opening: OpenDurableRunOptions<Tool> = options;
  const given = options.afterClaim;
  // Inside the claim's open, before the store opens: a factory that fails leaves nothing of this incarnation.
  const afterClaim =
    given &&
    (async ({ ref: claimRef, root, work, store }: Claim) => {
      const got = await given({ ref: claimRef, root, work, store });
      opening = { ...options, ...(got.harness ? { harness: got.harness } : {}), ...(got.beforeResume ? { beforeResume: got.beforeResume } : {}) };
      if (!opening.harness) throw new RunError("INVALID_ARGUMENT", "openDurableRun needs pi's Harness options: afterClaim returned none, and its options give none");
      return got.seed ? { seed: got.seed } : {};
    });
  // The claim's cleanup is the environment's: abandoning the claim cleans both.
  const lease = await openLease(ref, { ...options, context, cleanup: (c) => env?.cleanup(c) ?? Promise.resolve() }, step, afterClaim);
  try {
    env = (options.env ?? ((c: Claim) => archilEnv(c)))(lease.rawClaim);
  } catch (error) {
    await lease.abandon(error);
    throw error;
  }
  const run = new Run(lease, env, opening as unknown as OpenDurableRunOptions<ToolRegistration>, context);
  try {
    await run.open(step);
  } catch (error) {
    await run.abandon(error);
    throw error;
  }
  return run;
}
