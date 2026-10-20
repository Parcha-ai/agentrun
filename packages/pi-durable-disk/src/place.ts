// Places: where one run lives, and how its instance starts, is killed and comes back. A supervisor that decides when to
// kill (agentrun's reference demo) is the same for every place; the place decides how. `localPlace` runs the instance on
// a directory of this machine (`run --dir`, no disk and no key); `archilPlace` runs it on an Archil disk through a host
// driver, mints each attempt's mount token itself and takes the run over after a kill. The types match the reference's
// place seam (@parcha/agentrun-harness/place) structurally. The supervisor reads nothing under the run's directory: the
// outcome, the run's record and its delegations come through the place.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, extname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Delegation } from "disk";
import { DEFAULT_MOUNT_ROOT, findDelegations, mintMountToken, pathlessResolver, removeMountToken, runPath, type RunRef } from "./claim.ts";
import { reapCommands } from "./commands.ts";
import { HeldError, PdaError } from "./errors.ts";
import { takeOwnerLock } from "./run.ts";
import { readRunRecord, type RunRecord } from "./status.ts";
import {
  CONTROL_TIMEOUT_MS,
  ensureRunning,
  readRunStatus,
  readStartMark,
  TOKEN_TTL,
  type EnsureOptions,
  type EnsureResult,
  type HostBox,
  type HostDriver,
  type HostHandle,
  type HostStatus,
  type SupervisorControl,
  withTimeouts,
} from "./supervise.ts";

export type PlaceKill = "process" | "box";
/** The run's paths in the place: its id, its directory, and the `work` and `store` under it. */
export type PlacePaths = { id: string; root: string; work: string; store: string };
/**
 * How the run stood when a runner ended: the instance's own report, or `run.json` as it left it. `status` is the run's
 * word: `complete` when it delivered, else `failed`. `models`, on any status: the role-to-model ids the run's live parts
 * chose (`lead`, `eyes`, ...), when the app reported a plain object of strings; absent otherwise, never `{}` in its place.
 */
export type PlaceOutcome = { status: string; generation: number | null; code?: string | null; message?: string; record?: unknown; storeSha256?: string; models?: Record<string, string> };
/** How a runner ended. `exit`: the exit code or signal (local), or the host's status (`stopped`, `failed`, `gone`) or `SIGKILL` when the place killed it (archil). */
export type PlaceExit = { exit: number | string | null; signal: string | null; outcome?: PlaceOutcome; stderr: string };
/** One instance of the run in a place. `epoch`: 1 on a plain directory; on a disk, the generation the instance opens. */
export type PlaceRunner = { epoch: number; pid?: number; exited: Promise<PlaceExit> };
/** What a runner is handed: its number in the run, its environment, and for a place with a token, the attempt's mount token. */
export type RunnerOrder = { gen: number; env: Record<string, string>; stdin?: string };
/** What the place reads of the run, the way it reads it: `run.json`, and on a disk the run's delegations. */
/**
 * What the place reads of the run, the way it reads it: `run.json`; on a disk, the run's delegations; and the boxes the
 * place made for its runners, each as a receipt (`HostBox`: provider, kind, from, to, list price per second and where
 * that price was read), when its host driver makes boxes. A box the place released stays listed with its end.
 */
export type PlaceStatus = { record: RunRecord | null; delegations?: Pick<Delegation, "clientId" | "inodeId" | "path" | "isOrphaned" | "isPending">[]; boxes?: HostBox[] };
/** What a recovery did. A takeover on a disk lists what it revoked, and `ms` is the whole of it (revoke and start). */
export type PlaceRecovery = {
  runner: PlaceRunner;
  restored?: { checkpoint: string; head: number };
  replayed?: { from: number; to: number };
  revoked?: Pick<Delegation, "clientId" | "inodeId" | "path" | "isOrphaned">[];
  ms?: number;
};
/**
 * What a runner announces to its supervisor: a crossing it took, or a request to be killed at one (it parks there until
 * the kill). `signals-failed` is the place's own last word when it could not read the requests: it ends the iterator,
 * which never rejects. `code` is the failing read's error code when it has one (CONTROL_API_FAILED for a read that timed
 * out), else SIGNALS_FAILED.
 */
export type PlaceSignal =
  | {
      kind: "crossing" | "kill-request";
      crossing: { point: string; n: number; pid?: number; info?: Record<string, unknown> };
      /** The attempt's nonce the runner wrote into its request, lifted out of `crossing`: the supervisor honors a kill request only with the nonce it minted for that attempt. */
      nonce?: string;
    }
  | { kind: "signals-failed"; code: string; message: string };
/**
 * What the supervisor hands a place factory: the run's paths as it computed them, how to take the boxes the run made,
 * and where attempt n's runner writes its kill request (a file of the supervisor's machine).
 */
export type PlaceContext = { paths: PlacePaths; self?: string; destroyBoxes?: () => void | Promise<void>; requestFile?: (attempt: number) => string };

/**
 * Where an attempt's runner records (its RECORD_DIR, in the place) and how the place brings that recording home. For a
 * place whose runners cannot write the supervisor's recording directory.
 */
export interface PlaceRecordHome {
  /** The directory, in the place, attempt `attempt`'s runner records into. */
  dir(attempt: number): string;
  /**
   * Brings home into `into` what the runners recorded: blobs first, then the new whole lines of each `.spool/*.jsonl`.
   * Idempotent; `final` is the call after the runner ended, when nothing is still landing.
   */
  bringHome(into: string, options?: { final?: boolean }): Promise<void>;
  /** How far the place's clock is from the supervisor's, when it knows. */
  readonly clockSkewMs?: number;
}

export interface Place {
  /** `local` or `archil`, for the recording's lines. */
  readonly name: string;
  readonly paths: PlacePaths;
  /** A place whose instance opens a claim mints each attempt's mount token: the supervisor passes it as the runner's stdin, never in argv or env. */
  token?(attempt: number): string | undefined | Promise<string | undefined>;
  /** What this place can lose. */
  readonly kills: ReadonlyArray<PlaceKill>;
  start(order: RunnerOrder): Promise<PlaceRunner>;
  /**
   * Where attempt `attempt`'s runner writes its kill request, as a path in the place (the supervisor puts it in the
   * runner's order). A place with `signals` has it, and `signals(attempt)` reads what is written there.
   */
  requestFile?(attempt: number): string;
  /**
   * The kill requests (and crossings) attempt `attempt`'s runner announces. The supervisor stops reading with `return()`
   * once the runner has exited, and `return()` ends a pending `next()`.
   */
  signals?(attempt: number): AsyncIterable<PlaceSignal>;
  /** Takes the runner away abruptly, as a crash would. Safe on a runner that is already gone. */
  kill(runner: PlaceRunner, kind: PlaceKill): Promise<void>;
  status?(): Promise<PlaceStatus>;
  /** Kills `last` if it still runs, then starts the next runner. */
  recover(last: PlaceRunner, kind: PlaceKill, order: RunnerOrder): Promise<PlaceRecovery>;
  checkpoint?(): Promise<{ taken: boolean; heldBy?: string }>;
  move?(to: Place): Promise<Record<string, unknown>>;
  /** Lets the run go: stops what still runs (its commands too) and removes what the place made for it (tokens), never the run's directory. */
  release(): Promise<void>;
  /** A place whose runners record where the supervisor cannot read says where, and brings the recording home. */
  readonly recordHome?: PlaceRecordHome;
}

export type PlaceErrorCode = "INVALID_ARGUMENT" | "HELD" | "START_TIMED_OUT" | "STATUS_FAILED" | "KILL_UNSUPPORTED" | "RELEASE_FAILED" | "BOX_GONE" | "CARRY_FAILED" | "BLOB_MISMATCH" | "DIRS_REFUSED";

export class PlaceError extends PdaError {
  constructor(code: PlaceErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

// The package's own CLI, with the extension this module has: `.ts` from a checkout, `.js` once built.
const CLI = fileURLToPath(new URL(`./cli${extname(import.meta.url)}`, import.meta.url));
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** After the instance exits, how long its output may take to close (a command it left running can hold it open). */
const OUTPUT_GRACE_MS = 2_000;
/** How often a local place looks for a kill request (a file of this machine). */
const LOCAL_SIGNAL_POLL_MS = 20;
/** How long reads of a kill request may fail without a break before `signals` says so. */
const SIGNAL_FAIL_MS = 60_000;
/** An S3 read of a key that is not there (yet): the only failure a request poll expects. */
const notThere = (error: unknown): boolean => {
  const e = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return e.status === 404 || e.statusCode === 404 || e.code === "NoSuchKey";
};
const STDERR_KEEP = 600;
/** The longest message a place reports in a signal, as a kill line's. */
const MESSAGE_KEEP = 240;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The outcome `run.json` gives, in the run's vocabulary rather than the record's: `complete` when the run is `done` and
 * delivered a record (the detail of the app's last status carries one), `failed` for anything else (done with no result,
 * failed, or a run its instance left `running`, `paused` or `sleeping`). Its generation, and what the app put in that
 * detail.
 */
function outcomeOf(record: RunRecord | null | undefined): PlaceOutcome | undefined {
  if (!record) return undefined;
  const detail = record.detail !== null && typeof record.detail === "object" && !Array.isArray(record.detail) ? (record.detail as Record<string, unknown>) : {};
  const delivered = record.status === "done" && "record" in detail && detail.record !== null && detail.record !== undefined;
  const models = modelsOf(detail.models);
  return {
    status: delivered ? "complete" : "failed",
    generation: record.generation,
    code: typeof detail.code === "string" ? detail.code : null,
    ...(typeof detail.message === "string" ? { message: detail.message } : {}),
    ...("record" in detail ? { record: detail.record } : {}),
    ...(typeof detail.storeSha256 === "string" ? { storeSha256: detail.storeSha256 } : {}),
    ...(models ? { models } : {}),
  };
}

/**
 * The role-to-model ids an outcome carries: a copy of `value` when it is a plain object whose values are all strings,
 * else undefined, so a malformed report is left out and never stands in as `{}`.
 */
function modelsOf(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, id]) => typeof id === "string") ? (Object.fromEntries(entries) as Record<string, string>) : undefined;
}

const pathsUnder = (id: string, root: string): PlacePaths => ({ id, root, work: join(root, "work"), store: join(root, "store") });

// ---- the local place ----------------------------------------------------------------------------------------------------

export interface LocalPlaceOptions {
  /** The app module `run --app` loads. */
  app: string;
  /** The run's directory. Default: the context's `paths.root`. */
  root?: string;
  /** The instance program; `run` and its flags are appended. Default: this Node and the package's CLI. */
  command?: string[];
  /** Extra flags for `run` (heartbeat periods, a park threshold). */
  runArgs?: string[];
}

/**
 * The run on a directory of this machine: each runner is `pi-durable-disk run --dir <root> --id <id> --app <app>`, a
 * child in its own process group, with `{ PATH, ...order.env }` and nothing else of this process's environment. No disk,
 * no key and no token. A process kill is SIGKILL to the group, and the next runner resumes the run from the directory; a
 * box kill also takes the boxes the run made (`destroyBoxes`), so `kills` has `box` only when the context gives that.
 * A runner's outcome is the instance's `{"outcome":...}` line on stdout, or, without one, `run.json` as it left it.
 */
export function localPlace(options: LocalPlaceOptions): (ctx: PlaceContext) => Place {
  if (!options.app) throw new PlaceError("INVALID_ARGUMENT", "localPlace needs the app module the instance runs");
  return (ctx) => {
    runPath(ctx.paths.id);
    const root = resolve(options.root ?? ctx.paths.root);
    const paths = pathsUnder(ctx.paths.id, root);
    const command = options.command ?? [process.execPath, CLI];
    const alive = new Map<PlaceRunner, number>();
    /** A runner's boxes being taken, or taken: one deletion per runner, shared while in flight, retried after a failure. */
    const boxesTaken = new Map<PlaceRunner, Promise<void>>();

    const start = async (order: RunnerOrder): Promise<PlaceRunner> => {
      const argv = [...command.slice(1), "run", "--dir", root, "--id", paths.id, "--app", options.app, ...(options.runArgs ?? [])];
      const child = spawn(command[0], argv, {
        detached: true,
        env: { PATH: process.env.PATH || SAFE_PATH, ...order.env },
        stdio: [order.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      await new Promise<void>((ok, fail) => {
        child.once("spawn", ok);
        child.once("error", (err) => fail(new PlaceError("INVALID_ARGUMENT", `cannot start ${command[0]}`, { cause: err })));
      });
      if (order.stdin !== undefined) {
        child.stdin!.on("error", () => {});
        child.stdin!.end(order.stdin);
      }
      let outcome: PlaceOutcome | undefined;
      let partial = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) outcome = outcomeLine(line) ?? outcome;
      });
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
      const exited = new Promise<PlaceExit>((settle) => {
        let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        let done = false;
        const finish = async () => {
          if (done || !ended) return;
          done = true;
          outcome = outcomeLine(partial) ?? outcome;
          const fallback = outcome ? undefined : outcomeOf(await readRunRecord(root).catch(() => undefined));
          const report = outcome ?? fallback;
          settle({ exit: ended.signal ?? ended.code, signal: ended.signal, ...(report ? { outcome: report } : {}), stderr: stderr.trim().slice(0, STDERR_KEEP) });
        };
        child.once("exit", (code, signal) => {
          // Its pid is free from here: no kill may reach the group by it again.
          alive.delete(runner);
          ended = { code, signal };
          setTimeout(() => void finish(), OUTPUT_GRACE_MS).unref();
        });
        child.once("close", () => void finish());
      });
      const runner: PlaceRunner = { epoch: 1, pid: child.pid!, exited };
      alive.set(runner, child.pid!);
      return runner;
    };

    const kill = async (runner: PlaceRunner, kind: PlaceKill): Promise<void> => {
      // Only a runner still alive: its pid (the group's id) is not yet free for another process to take.
      const pid = alive.get(runner);
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      await runner.exited;
      // Once per runner: a supervisor that kills and then recovers the same runner takes its boxes once. A deletion that
      // failed is forgotten, so the next kill or recover tries again before any runner starts.
      if (kind === "box" && ctx.destroyBoxes) {
        let taking = boxesTaken.get(runner);
        if (!taking) {
          taking = (async () => ctx.destroyBoxes!())().then(
            () => undefined,
            (error: unknown) => {
              boxesTaken.delete(runner);
              throw error;
            },
          );
          boxesTaken.set(runner, taking);
        }
        await taking;
      }
    };

    return {
      name: "local",
      paths,
      kills: ctx.destroyBoxes ? ["process", "box"] : ["process"],
      start,
      // The runner is a child of this machine, so its kill request is the supervisor's own file.
      ...(ctx.requestFile
        ? {
            requestFile: ctx.requestFile,
            signals: (attempt: number) => {
              const file = ctx.requestFile!(attempt);
              return requestSignals(async () => (existsSync(file) ? readFileSync(file, "utf8") : undefined), LOCAL_SIGNAL_POLL_MS, SIGNAL_FAIL_MS);
            },
          }
        : {}),
      kill,
      status: async () => ({ record: (await readRunRecord(root)) ?? null }),
      recover: async (last, kind, order) => {
        await kill(last, kind);
        return { runner: await start(order) };
      },
      release: async () => {
        await Promise.all([...alive.keys()].map((runner) => kill(runner, "process")));
        // pi runs each command in a process group of its own, which the instance's kill does not reach: end what the
        // run recorded, as its next open would, since there may be none. Only under the run's owner lock, as an open
        // does: while another process holds the run, the commands are its own, not this place's.
        const commands = join(root, "commands");
        if (!existsSync(commands)) return;
        let lock: ReturnType<typeof takeOwnerLock>;
        try {
          lock = takeOwnerLock(root);
        } catch (error) {
          if (error instanceof HeldError) return;
          throw error;
        }
        let reaped: Awaited<ReturnType<typeof reapCommands>>;
        try {
          reaped = await reapCommands(commands);
        } finally {
          lock.release();
        }
        if (reaped.survivors.length > 0) {
          throw new PlaceError("RELEASE_FAILED", `releasing ${root} left commands alive after SIGKILL: pids ${reaped.survivors.map((m) => m.pid).join(", ")}`);
        }
      },
    };
  };
}

/**
 * The kill request a runner writes whole when it parks at its planned crossing, as one signal, read with `read` every
 * `pollMs` until it names a crossing. `read` answers undefined while there is no request yet; a read that fails is tried
 * again, and once reads have failed for `failMs` without a break, the iterator yields one `signals-failed` and ends (a
 * runner parked at its crossing would otherwise wait with no word of why). It never rejects. A custom iterator, not a
 * generator: `return()` must end a
 * pending `next()`, which a generator would queue behind the poll, and it does even while a read is in flight (a read
 * over the network can hang). Each wait has its own wake, dropped after it, so a long poll attaches nothing to anything
 * that lives as long as the iterator.
 */
function requestSignals(read: () => Promise<string | undefined>, pollMs: number, failMs: number): AsyncIterable<PlaceSignal> {
  return {
    [Symbol.asyncIterator]() {
      let closed = false;
      let wake: (() => void) | undefined;
      /** `work`, or undefined as soon as `return()` runs. */
      const unlessReturned = <T>(work: Promise<T>): Promise<T | undefined> =>
        new Promise<T | undefined>((resolve, reject) => {
          wake = () => resolve(undefined);
          work.then(resolve, reject);
        }).finally(() => {
          wake = undefined;
        });
      let failingSince: number | undefined;
      return {
        async next(): Promise<IteratorResult<PlaceSignal>> {
          while (!closed) {
            let text: string | undefined;
            try {
              text = await unlessReturned(read());
              failingSince = undefined;
            } catch (error) {
              failingSince ??= Date.now();
              if (!closed && Date.now() - failingSince >= failMs) {
                closed = true;
                const code = (error as { code?: unknown } | null)?.code;
                const message = `reading the kill request failed for ${failMs} ms: ${String((error as Error | null)?.message ?? error)}`.slice(0, MESSAGE_KEEP);
                return { done: false, value: { kind: "signals-failed", code: typeof code === "string" && code ? code : "SIGNALS_FAILED", message } };
              }
            }
            const request = closed || text === undefined ? undefined : requestIn(text);
            if (request) {
              closed = true;
              // The nonce is the signal's, not the crossing's: a supervisor reads it at the top, as from any place.
              const { nonce, ...crossing } = request;
              return { done: false, value: { kind: "kill-request", crossing, ...(typeof nonce === "string" ? { nonce } : {}) } };
            }
            if (!closed) await unlessReturned(sleep(pollMs));
          }
          return { done: true, value: undefined };
        },
        async return(): Promise<IteratorResult<PlaceSignal>> {
          closed = true;
          wake?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** What a kill request file holds: the crossing, with the attempt's nonce beside its fields. */
type RequestCrossing = Extract<PlaceSignal, { crossing: unknown }>["crossing"] & { nonce?: unknown };

/**
 * What a request names: `point` and `n` at least, with every other field it carries; the per-attempt nonce the
 * supervisor put in the order (never the place's token) is lifted out of the crossing into the signal. Anything else (a
 * half write, another file) is not one yet.
 */
function requestIn(text: string): RequestCrossing | undefined {
  try {
    const v = JSON.parse(text) as Partial<RequestCrossing> | null;
    return v && typeof v.point === "string" && typeof v.n === "number" && Number.isFinite(v.n) ? (v as RequestCrossing) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `outcome` of a `{"outcome":{...}}` line with at least a status; undefined for any other line. Its `models` stays
 * only when it is a plain object of strings (`modelsOf`), as `run.json`'s does.
 */
function outcomeLine(line: string): PlaceOutcome | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(line) as { outcome?: PlaceOutcome };
    if (!parsed.outcome || typeof parsed.outcome !== "object" || typeof parsed.outcome.status !== "string") return undefined;
    const { models: reported, ...outcome } = parsed.outcome as PlaceOutcome & { models?: unknown };
    const models = modelsOf(reported);
    return models ? { ...outcome, models } : outcome;
  } catch {
    return undefined;
  }
}

// ---- the Archil place ---------------------------------------------------------------------------------------------------

export interface ArchilPlaceOptions {
  disk: string;
  region: string;
  /**
   * The disk's control API (`archilControl`). The place holds it; no instance ever does. With `listObjects` (as
   * `archilControl` has), the place has `recordHome`.
   */
  control: SupervisorControl & Partial<RecordControl>;
  /**
   * The driver that runs the instance (`localHost`, `dockerHost`, `daytonaHost`), set up with the app the instance runs.
   * Its `kill` and `kills` are the place's.
   */
  host: HostDriver;
  /** The run's id on the disk. Default: the context's `paths.id`. */
  id?: string;
  /** Where the driver mounts runs, for `paths`. Default: the driver's `mountRoot`, else /mnt/archil. */
  mountRoot?: string;
  /** More for each start's `ensureRunning`: the run directory's owner (`create`), token prefix and TTL, timeouts. */
  ensure?: Omit<EnsureOptions, "control" | "demand" | "mountToken">;
  /** How often a runner's host status is read. Default 1 s. */
  pollMs?: number;
  /** How long a start waits on a mount another start has in flight. Default 60 s. */
  startTimeoutMs?: number;
  /** How often `signals` reads the attempt's kill request over S3. Default 500 ms (the runner waits at its crossing). */
  signalPollMs?: number;
  /**
   * How long those reads may fail (anything but a missing object) without a break before the iterator yields one
   * `signals-failed` and ends. Default 60 s.
   */
  signalFailMs?: number;
}

type Minted = { token: string; identifier: string; nickname: string; removed: boolean };

/** Where in the run's directory an Archil place's runners write their kill requests. */
const REQUESTS = "signals";

// ---- bringing a recording home ------------------------------------------------------------------------------------------

/** The listing `recordHome` reads the run's recordings with: S3 ListObjects, each object's size when the API gives it. */
export interface RecordControl {
  listObjects(prefix: string, options?: { recursive?: boolean }): Promise<{ objects: { key: string; size?: number }[] }>;
}

/** Where in the run's directory an Archil place's runners record, one directory per attempt. */
const RECORDS = "record";
const BLOB_NAME = /^([0-9a-f]{64})\.[A-Za-z0-9]{1,16}$/;
const SPOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.jsonl$/;
const NEWLINE = 0x0a;

/** A message for a recording's line: at most 240 characters, so it never carries more than the line can hold. */
const said = (text: string): string => text.slice(0, MESSAGE_KEEP);

/**
 * Every byte of `bytes` to `fd`: a write may take fewer bytes than it was given, so it goes on from where the last one
 * stopped. A write that takes none fails, as one that throws (a full disk) does.
 */
export function writeAll(fd: number, bytes: Uint8Array, write: (fd: number, bytes: Uint8Array, offset: number, length: number) => number = writeSync): void {
  for (let at = 0; at < bytes.length; ) {
    const n = write(fd, bytes, at, bytes.length - at);
    if (!(n > 0)) throw new PlaceError("CARRY_FAILED", `a write took no bytes, ${bytes.length - at} of ${bytes.length} left`);
    at += n;
  }
}

/** `bytes` into `file` whole: a temporary file, fsync, rename, then the directory's fsync. */
function writeWhole(file: string, bytes: Uint8Array): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, file);
  syncDir(dir);
}

/** `bytes` at the end of `file`, fsynced; a file it creates is made durable in its directory too. */
function appendDurably(file: string, bytes: Uint8Array): void {
  const dir = dirname(file);
  const created = !existsSync(file);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(file, "a", 0o644);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) syncDir(dir);
}

/** How long a carrier waits for another one appending to the same destination file. */
const CARRY_LOCK_WAIT_MS = 5_000;
/** A lock file with no holder written yet (its taker is between the create and the write) counts as held this long. */
const CARRY_LOCK_UNNAMED_MS = 10_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * `fn` while holding `lock`, a file created exclusively that names its holder's pid, so two carriers on one destination
 * (two places, two processes) never append at once. A lock whose holder is gone (its process ended) is taken over; one a
 * live holder keeps past CARRY_LOCK_WAIT_MS is CARRY_FAILED. `fn` is synchronous, so the lock is held only for it.
 */
async function withCarryLock(lock: string, fn: () => void): Promise<void> {
  for (const t0 = Date.now(); ; ) {
    let fd: number | undefined;
    try {
      fd = openSync(lock, "wx", 0o644);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (fd !== undefined) {
      // Once created, the lock goes on every way out: a failed write of the pid or close of the file included.
      try {
        try {
          writeAll(fd, new TextEncoder().encode(String(process.pid)));
        } finally {
          closeSync(fd);
        }
        fn();
      } finally {
        rmSync(lock, { force: true });
      }
      return;
    }
    let holder = 0;
    let ageMs = 0;
    try {
      holder = Number(readFileSync(lock, "utf8").trim());
      ageMs = Date.now() - statSync(lock).mtimeMs;
    } catch (error) {
      // Released meanwhile: take it on the next turn. Any other failure to read it (its mode, the disk) is the carry's.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && Date.now() - t0 <= CARRY_LOCK_WAIT_MS) continue;
      throw new PlaceError("CARRY_FAILED", said(`reading the carry lock ${lock} failed: ${(error as Error)?.message ?? error}`), { cause: error });
    }
    const gone = Number.isSafeInteger(holder) && holder > 0 ? !alive(holder) : ageMs > CARRY_LOCK_UNNAMED_MS;
    if (gone) {
      rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() - t0 > CARRY_LOCK_WAIT_MS) throw new PlaceError("CARRY_FAILED", said(`another carrier (pid ${holder || "unnamed"}) holds ${lock} past ${CARRY_LOCK_WAIT_MS} ms`));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The blob hashes (SHA-256, hex) a recording's line names in its `blobs`; none for a line that is not JSON or names none. */
function blobsOf(line: Uint8Array): string[] {
  try {
    const v = JSON.parse(new TextDecoder().decode(line)) as { blobs?: unknown };
    return Array.isArray(v?.blobs) ? v.blobs.filter((b): b is string => typeof b === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Brings home into `into` what the runners recorded under `prefix` (`runs/<id>/record/`), read through the control (S3
 * ListObjects and GetObject: nothing takes the run's claim). It keeps no state: a blob is home when `into/blobs/<name>`
 * exists, and a spool file's carried bytes are what `into/.spool/<name>` holds, so a second call, or a call from another
 * process, carries nothing twice. Carriers that overlap on one destination never append at once: the place runs one call
 * at a time per destination, and every append happens under a lock file beside its spool file (`.<name>.lock`, naming
 * its holder's pid), where the destination's size is read again so only the lines past it are appended. A lock whose
 * holder is gone is taken over; one held past 5 s is CARRY_FAILED. Every write is carried to its last byte.
 * - Blobs first: each one not yet home is fetched, checked against the hash its name carries, and written whole into
 *   `into/blobs`. One whose bytes do not match is skipped; everything else is brought home, then the call throws
 *   BLOB_MISMATCH, and the next call tries that blob again.
 * - Then lines: the new whole lines of each `.spool/<name>.jsonl`, the recorder's segments (`<stream>.<n>.jsonl`), each
 *   with its own offset: what `into/.spool/<name>` already holds. A file is fetched only when it grew since this place
 *   last fetched it (the SDK has no ranged read). A line whose blobs are not home yet waits for the next call, so no line arrives before its blob; on
 *   `final` it is carried anyway, and its missing blobs are CARRY_FAILED once everything else is home.
 * - A listing or fetch that fails is CARRY_FAILED. The recording is on the run's disk, not in the box, so a lost box
 *   costs only what it had not fsynced: this place never throws BOX_GONE.
 */
async function carryHome(control: Pick<SupervisorControl, "getObject"> & RecordControl, prefix: string, into: string, final: boolean, fetched: Map<string, number>): Promise<void> {
  const fetch = async (key: string): Promise<Uint8Array> => {
    try {
      return await control.getObject(key);
    } catch (error) {
      throw new PlaceError("CARRY_FAILED", said(`reading ${key.slice(prefix.length)} of the run's recording failed: ${(error as Error)?.message ?? error}`), { cause: error });
    }
  };
  let objects: { key: string; size?: number }[];
  try {
    objects = (await control.listObjects(prefix, { recursive: true })).objects;
  } catch (error) {
    throw new PlaceError("CARRY_FAILED", said(`listing the run's recording failed: ${(error as Error)?.message ?? error}`), { cause: error });
  }
  // `<attempt>/blobs/<name>` and `<attempt>/.spool/<name>.jsonl`; anything else (`started`, a box's temporary file) is not carried.
  const parts = (key: string) => key.slice(prefix.length).split("/");
  const blobs = objects.filter((o) => {
    const p = parts(o.key);
    return p.length === 3 && p[1] === "blobs" && BLOB_NAME.test(p[2]);
  });
  const spools = objects.filter((o) => {
    const p = parts(o.key);
    return p.length === 3 && p[1] === ".spool" && SPOOL_NAME.test(p[2]);
  });
  const home = (name: string) => existsSync(join(into, "blobs", name));
  const mismatched: string[] = [];
  for (const blob of blobs) {
    const name = parts(blob.key)[2];
    if (home(name)) continue;
    const bytes = await fetch(blob.key);
    if (createHash("sha256").update(bytes).digest("hex") !== BLOB_NAME.exec(name)![1]) {
      mismatched.push(name);
      continue;
    }
    writeWhole(join(into, "blobs", name), bytes);
  }
  // A line names its blobs by hash; the file is `<hash>.<ext>`.
  const homeHashes = new Set(existsSync(join(into, "blobs")) ? readdirSync(join(into, "blobs")).map((n) => BLOB_NAME.exec(n)?.[1]).filter((h): h is string => h !== undefined) : []);
  const waiting = new Set<string>();
  for (const spool of spools) {
    const name = parts(spool.key)[2];
    const dest = join(into, ".spool", name);
    const carried = existsSync(dest) ? statSync(dest).size : 0;
    // Not fetched again while its size is what this place last fetched and nothing in it waited for a blob (a partial
    // last line keeps it bigger than what is home). Never skipped on `final`. Only a saving: what is home is still what
    // the destination holds.
    // Per destination: what this place fetched for one `into` says nothing of another.
    const cacheKey = `${resolve(into)}\0${spool.key}`;
    if (spool.size !== undefined && (spool.size <= carried || (!final && fetched.get(cacheKey) === spool.size))) continue;
    const bytes = await fetch(spool.key);
    if (bytes.length <= carried) continue;
    let heldForBlob = false;
    let end = carried;
    for (let at = carried; at < bytes.length; ) {
      const nl = bytes.indexOf(NEWLINE, at);
      if (nl < 0) break; // a line still being written
      const missing = blobsOf(bytes.subarray(at, nl)).filter((hash) => !homeHashes.has(hash));
      if (missing.length > 0 && !final) {
        heldForBlob = true;
        break;
      }
      for (const b of missing) waiting.add(b);
      end = nl + 1;
      at = nl + 1;
    }
    if (end > carried) {
      // Another carrier on this destination (another place, another process) may have appended since `carried` was read.
      // Under the file's lock, what the destination holds now decides: only the lines past it are appended.
      mkdirSync(dirname(dest), { recursive: true });
      await withCarryLock(join(dirname(dest), `.${name}.lock`), () => {
        const now = existsSync(dest) ? statSync(dest).size : 0;
        if (end > now) appendDurably(dest, bytes.subarray(now, end));
      });
    }
    if (heldForBlob) fetched.delete(cacheKey);
    else fetched.set(cacheKey, bytes.length);
  }
  if (mismatched.length > 0) {
    throw new PlaceError("BLOB_MISMATCH", said(`${mismatched.length} blob(s) of the run's recording do not hash to their names: ${mismatched.join(", ")}`));
  }
  if (final && waiting.size > 0) {
    throw new PlaceError("CARRY_FAILED", said(`${waiting.size} blob(s) the run's recording names never reached its disk: ${[...waiting].join(", ")}`));
  }
}
const countFrom1 = (attempt: number): number => {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new PlaceError("INVALID_ARGUMENT", `attempt ${attempt} is not a count from 1`);
  return attempt;
};
const requestName = (attempt: number): string => `kill-${countFrom1(attempt)}.json`;

/**
 * The run on an Archil disk, its instance run by a host driver. `token(attempt)` mints the attempt's mount token through
 * the place's control, and the runner it is handed to mounts with it. A start is `ensureRunning` (it creates the run's
 * directory with `ensure.create` and writes the start mark) with that token and the order's environment. A kill is the
 * driver's `kill`: `process` or `box`, whichever the driver takes. A recovery is the takeover: the dead holder's
 * delegations revoked (its lease counts as expired, since the place killed it) and the next instance started, which
 * `revoked` and `ms` report. A runner writes its kill request in the run's directory (`requestFile`), and `signals` reads
 * it over S3. A runner ends when the driver no longer reports it running, or when the place killed it; its
 * outcome is `run.json` read over S3, with `code`, `message`, `record` and `storeSha256` from the detail of the last
 * status the app set. `release` stops every instance it started and removes every token it minted; the run's directory
 * stays (`deleteRunTree`).
 */
export function archilPlace(options: ArchilPlaceOptions): (ctx: PlaceContext) => Place {
  const { host } = options;
  // Every call the place makes on the disk is bounded as ensureRunning bounds its own: one that does not answer fails as
  // CONTROL_API_FAILED, so a stalled request never leaves a recovery, a release or a runner's end waiting forever.
  const control = withTimeouts(options.control, options.ensure?.controlTimeoutMs ?? CONTROL_TIMEOUT_MS);
  const pollMs = options.pollMs ?? 1_000;
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
  const signalPollMs = options.signalPollMs ?? 500;
  const signalFailMs = options.signalFailMs ?? SIGNAL_FAIL_MS;
  return (ctx) => {
    const ref: RunRef = { disk: options.disk, region: options.region, id: options.id ?? ctx.paths.id };
    runPath(ref.id);
    const hostRoot = (host as { mountRoot?: unknown }).mountRoot;
    const mountRoot = options.mountRoot ?? (typeof hostRoot === "string" ? hostRoot : DEFAULT_MOUNT_ROOT);
    const root = posix.join(mountRoot, runPath(ref.id));
    const paths: PlacePaths = { id: ref.id, root, work: posix.join(root, "work"), store: posix.join(root, "store") };
    const minted = new Map<string, Minted>();
    const handles: HostHandle[] = [];
    /** Every handle the place started, released or not: the boxes it reports. */
    const started: HostHandle[] = [];
    const killed = new Map<PlaceRunner, () => void>();
    let resolver = pathlessResolver(control);
    const records = `${runPath(ref.id)}/${RECORDS}/`;
    const recording = typeof options.control.listObjects === "function";
    const owner = options.ensure?.create;
    /**
     * Before attempt `gen`'s runner starts: the EMPTY directories it writes into, `signals/` and, with `recordHome`,
     * `record/<gen>/.spool/` and `record/<gen>/blobs/`, made over the control (PutObject with the owner, as createRunDir
     * does: an exec mkdir would make them root's) and owned by the run user (`ensure.create`), in ensureRunning's window
     * where no delegation holds the run (a held run refuses them: DIRS_REFUSED). A directory a process
     * made by path on an Archil mount was seen to refuse file creates afterwards (ENOENT), and one made over the control
     * does not. Every file in them stays the runner's (its kill request, its started, its spool), and a runner that
     * makes them itself finds them made. Without an owner nothing is made: a directory the run user does not own would
     * refuse the runner's files.
     */
    const makeDirs = async (gen: number): Promise<void> => {
      if (!owner) return;
      const run = `${runPath(ref.id)}/`;
      const dirs = [`${run}${REQUESTS}/`, ...(recording ? [`${run}${RECORDS}/`, `${run}${RECORDS}/${gen}/`, `${run}${RECORDS}/${gen}/.spool/`, `${run}${RECORDS}/${gen}/blobs/`] : [])];
      for (const dir of dirs) {
        try {
          if (!(await control.headObject(dir))) await control.putObject(dir, "", { uid: owner.uid, gid: owner.gid, mode: owner.mode ?? 0o755 });
        } catch (error) {
          throw new PlaceError("DIRS_REFUSED", said(`making ${dir.slice(run.length)} in the run over the control was refused: ${(error as Error)?.message ?? error}`), { cause: error });
        }
      }
    };
    const fetchedSizes = new Map<string, number>();
    const carrying = new Map<string, Promise<void>>();
    const handleOf = new Map<PlaceRunner, HostHandle>();

    const mint = async (attempt: number): Promise<Minted> => {
      const t = await mintMountToken(control, { run: { id: ref.id, attempt }, prefix: options.ensure?.tokenPrefix, ttl: options.ensure?.tokenTtl ?? TOKEN_TTL });
      const m = { ...t, removed: false };
      minted.set(t.token, m);
      return m;
    };
    const drop = async (m: Minted) => {
      if (m.removed) return;
      await removeMountToken(control, m.identifier);
      m.removed = true;
    };

    const outcome = async (): Promise<PlaceOutcome | undefined> => outcomeOf(await readRunStatus(control, ref.id).catch(() => null));

    const watch = (handle: HostHandle): { exited: Promise<PlaceExit>; kill: () => void } => {
      let onKill = () => {};
      const killedNow = new Promise<"killed">((r) => (onKill = () => r("killed")));
      let wasKilled = false;
      const exited = (async (): Promise<PlaceExit> => {
        let failures = 0;
        let status: HostStatus = "running";
        while (!wasKilled) {
          try {
            status = await host.status(handle);
            failures = 0;
          } catch (err) {
            if (++failures >= 10) throw new PlaceError("STATUS_FAILED", `the status of ${String(handle.name ?? handle.driver)} failed ${failures} times`, { cause: err });
          }
          if (failures === 0 && status !== "running") break;
          await Promise.race([sleep(pollMs), killedNow]);
        }
        const report = await outcome();
        return wasKilled
          ? { exit: "SIGKILL", signal: "SIGKILL", ...(report ? { outcome: report } : {}), stderr: "" }
          : { exit: status, signal: null, ...(report ? { outcome: report } : {}), stderr: "" };
      })();
      return {
        exited,
        kill: () => {
          wasKilled = true;
          onKill();
        },
      };
    };

    /** A start or a takeover: `ensureRunning` with the order's token and environment, until it starts or decides there is nothing to start. */
    const ensure = async (order: RunnerOrder, takeover: boolean): Promise<{ result: EnsureResult; runner: PlaceRunner; ms: number }> => {
      const given = order.stdin !== undefined ? minted.get(order.stdin) : undefined;
      const m = given && !given.removed ? given : await mint(order.gen);
      // The driver gets the order's environment with each start; everything else is the host's own.
      const driver: HostDriver = {
        // Inside ensureRunning, after its revoke and start mark: no delegation holds the run, so S3 takes the writes.
        start: async (r, token, attempt) => {
          await makeDirs(order.gen);
          return host.start(r, token, { attempt: attempt?.attempt ?? order.gen, env: order.env });
        },
        status: (h) => host.status(h),
        stop: (h) => host.stop(h),
      };
      const t0 = performance.now();
      const deadline = Date.now() + startTimeoutMs;
      for (;;) {
        let result: EnsureResult;
        try {
          result = await ensureRunning(ref, driver, {
            ...options.ensure,
            control,
            demand: true,
            mountToken: m,
            // The place killed the holder: whatever its lease says, it is expired, and no start of it is in flight.
            ...(takeover ? { leaseExpiryMs: Number.NEGATIVE_INFINITY, startGraceMs: 0 } : {}),
          });
        } catch (err) {
          // Nothing mounted with the token. ensureRunning's own removal ignores a failure, so remove it again (Archil
          // answers a removal of a gone user with success): a failure here leaves it for release.
          await drop(m).catch(() => {});
          throw err;
        }
        if (result.action === "started") {
          // An adopted instance mounts with an earlier start's token: this one is unused, removed as above.
          if (result.adopted) await drop(m).catch(() => {});
          handles.push(result.handle);
          started.push(result.handle);
          const w = watch(result.handle);
          const mark = result.startMark ? await readStartMark(control, ref.id).catch(() => null) : null;
          const runner: PlaceRunner = { epoch: mark?.generation ?? order.gen, exited: w.exited };
          killed.set(runner, w.kill);
          handleOf.set(runner, result.handle);
          // A runner the driver reports ended is gone: a later kill of it is a no-op. One whose status could not be read
          // may still run, so it stays killable.
          w.exited.then(
            () => void killed.delete(runner),
            () => undefined,
          );
          return { result, runner, ms: Math.round(performance.now() - t0) };
        }
        if ((result.action === "pending" || result.action === "starting") && Date.now() < deadline) {
          await sleep(pollMs);
          continue;
        }
        await drop(m).catch(() => {});
        if (result.action === "terminal") {
          // Nothing to start: the run is done or failed, and the runner ends as it begins.
          const report = await outcome();
          return { result, runner: { epoch: result.generation, exited: Promise.resolve({ exit: null, signal: null, ...(report ? { outcome: report } : {}), stderr: "" }) }, ms: Math.round(performance.now() - t0) };
        }
        if (result.action === "healthy") throw new PlaceError("HELD", `${runPath(ref.id)} is held by a live instance this place did not start`);
        throw new PlaceError("START_TIMED_OUT", `${runPath(ref.id)} stayed ${result.action} for ${startTimeoutMs} ms`);
      }
    };

    // The driver's kill, whatever the kind asked: it takes what `kills` says. Once per runner.
    const kill = async (runner: PlaceRunner, _kind: PlaceKill): Promise<void> => {
      if (!host.kill) throw new PlaceError("KILL_UNSUPPORTED", "the place's host driver has no kill");
      const handle = handleOf.get(runner);
      const end = killed.get(runner);
      if (handle && end) {
        await host.kill(handle);
        killed.delete(runner);
        end();
        // The kill is made; a runner whose status reads had failed still reports that failure through `exited`.
        await runner.exited.catch(() => undefined);
        return;
      }
      await runner.exited;
    };

    return {
      name: "archil",
      paths,
      kills: host.kill && host.kills ? [host.kills] : [],
      token: async (attempt) => (await mint(attempt)).token,
      ...(recording
        ? {
            recordHome: {
              // In the run's directory, so the runner's delegation covers it and deleteRunTree removes it.
              dir: (attempt: number) => posix.join(root, RECORDS, String(countFrom1(attempt))),
              // One carry at a time per destination in this place; another place or process is held off by the file lock.
              bringHome: (into: string, carry: { final?: boolean } = {}) => {
                const key = resolve(into);
                const run = (carrying.get(key) ?? Promise.resolve()).catch(() => {}).then(() => carryHome(control as SupervisorControl & RecordControl, records, into, carry.final === true, fetchedSizes));
                const settled = run.then(() => {}, () => {});
                carrying.set(key, settled);
                void settled.then(() => {
                  if (carrying.get(key) === settled) carrying.delete(key);
                });
                return run;
              },
            },
          }
        : {}),
      // The request goes in the run's directory, outside work/ where the agent's tools are confined, and the place reads
      // it over S3: a runner on a box of its own cannot reach the supervisor's files.
      requestFile: (attempt) => posix.join(root, REQUESTS, requestName(attempt)),
      signals: (attempt) => {
        const key = `${runPath(ref.id)}/${REQUESTS}/${requestName(attempt)}`;
        return requestSignals(
          async () => {
            try {
              return new TextDecoder().decode(await control.getObject(key));
            } catch (error) {
              if (notThere(error)) return undefined;
              throw error;
            }
          },
          signalPollMs,
          signalFailMs,
        );
      },
      start: async (order) => (await ensure(order, false)).runner,
      kill,
      status: async () => {
        // One resolver for the place's life: Archil lists a fresh run's delegation with no path, and its inode cache spares
        // every later call the `find` on the disk. It keeps its first failure for good, so a failed call gets the next
        // call a new one: one transient error must not fail the rest of a long run.
        const resolve = resolver;
        const [record, delegations] = await Promise.all([
          readRunStatus(control, ref.id),
          findDelegations(control, ref.id, resolve).catch((error: unknown) => {
            if (resolver === resolve) resolver = pathlessResolver(control);
            throw error;
          }),
        ]);
        const boxes = host.box ? started.map((h) => host.box!(h)).filter((b): b is HostBox => b !== null) : undefined;
        return { record, delegations: delegations.map(({ clientId, inodeId, path, isOrphaned, isPending }) => ({ clientId, inodeId, path, isOrphaned, isPending })), ...(boxes ? { boxes } : {}) };
      },
      recover: async (last, kind, order) => {
        if (killed.has(last)) await kill(last, kind);
        // Forced only while the newest incarnation the disk knows of (run.json or a start mark) is the one this place
        // killed. A newer one, another supervisor's, gets the usual lease and start-grace checks.
        const [record, mark] = await Promise.all([readRunStatus(control, ref.id), readStartMark(control, ref.id)]);
        const newest = Math.max(record?.generation ?? 0, mark?.generation ?? 0);
        const { result, runner, ms } = await ensure(order, handleOf.has(last) && newest <= last.epoch);
        return { runner, revoked: result.action === "started" ? result.revoked : [], ms };
      },
      release: async () => {
        const failed: string[] = [];
        // A handle leaves the list only once its stop succeeded, so a later release tries a failed one again.
        for (const handle of [...handles]) {
          try {
            await host.stop(handle);
            handles.splice(handles.indexOf(handle), 1);
          } catch (err) {
            failed.push(`stop ${String(handle.name ?? handle.driver)}: ${(err as Error).message}`);
          }
        }
        for (const m of minted.values()) {
          await drop(m).catch((err: unknown) => failed.push(`token ${m.nickname}: ${(err as Error).message}`));
        }
        if (failed.length) throw new PlaceError("RELEASE_FAILED", `releasing ${runPath(ref.id)} left: ${failed.join("; ")}`);
      },
    };
  };
}
