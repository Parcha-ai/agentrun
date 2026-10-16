// Places: where one run lives, and how its instance starts, is killed and comes back. A supervisor that decides when to
// kill (agentrun's reference demo) is the same for every place; the place decides how. `localPlace` runs the instance on
// a directory of this machine (`run --dir`, no disk and no key); `archilPlace` runs it on an Archil disk through a host
// driver, mints each attempt's mount token itself and takes the run over after a kill. The types match the reference's
// place seam (examples/reference/place.ts) structurally. The supervisor reads nothing under the run's directory: the
// outcome, the run's record and its delegations come through the place.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, posix, resolve } from "node:path";
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
  type HostDriver,
  type HostHandle,
  type HostStatus,
  type SupervisorControl,
  withTimeouts,
} from "./supervise.ts";

export type PlaceKill = "process" | "box";
/** The run's paths in the place: its id, its directory, and the `work` and `store` under it. */
export type PlacePaths = { id: string; root: string; work: string; store: string };
/** How the run stood when a runner ended: the instance's own report, or `run.json` as it left it. */
export type PlaceOutcome = { status: string; generation: number | null; code?: string | null; message?: string; record?: unknown; storeSha256?: string };
/** How a runner ended. `exit`: the exit code or signal (local), or the host's status (`stopped`, `failed`, `gone`) or `SIGKILL` when the place killed it (archil). */
export type PlaceExit = { exit: number | string | null; signal: string | null; outcome?: PlaceOutcome; stderr: string };
/** One instance of the run in a place. `epoch`: 1 on a plain directory; on a disk, the generation the instance opens. */
export type PlaceRunner = { epoch: number; pid?: number; exited: Promise<PlaceExit> };
/** What a runner is handed: its number in the run, its environment, and for a place with a token, the attempt's mount token. */
export type RunnerOrder = { gen: number; env: Record<string, string>; stdin?: string };
/** What the place reads of the run, the way it reads it: `run.json`, and on a disk the run's delegations. */
export type PlaceStatus = { record: RunRecord | null; delegations?: Pick<Delegation, "clientId" | "inodeId" | "path" | "isOrphaned" | "isPending">[] };
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
}

export type PlaceErrorCode = "INVALID_ARGUMENT" | "HELD" | "START_TIMED_OUT" | "STATUS_FAILED" | "KILL_UNSUPPORTED" | "RELEASE_FAILED";

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

/** The outcome `run.json` gives: its status and generation, and what the app put in its last detail. */
function outcomeOf(record: RunRecord | null | undefined): PlaceOutcome | undefined {
  if (!record) return undefined;
  const detail = record.detail !== null && typeof record.detail === "object" && !Array.isArray(record.detail) ? (record.detail as Record<string, unknown>) : {};
  return {
    status: record.status,
    generation: record.generation,
    code: typeof detail.code === "string" ? detail.code : null,
    ...(typeof detail.message === "string" ? { message: detail.message } : {}),
    ...("record" in detail ? { record: detail.record } : {}),
    ...(typeof detail.storeSha256 === "string" ? { storeSha256: detail.storeSha256 } : {}),
  };
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

/** The `outcome` of a `{"outcome":{...}}` line with at least a status; undefined for any other line. */
function outcomeLine(line: string): PlaceOutcome | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(line) as { outcome?: PlaceOutcome };
    return parsed.outcome && typeof parsed.outcome === "object" && typeof parsed.outcome.status === "string" ? parsed.outcome : undefined;
  } catch {
    return undefined;
  }
}

// ---- the Archil place ---------------------------------------------------------------------------------------------------

export interface ArchilPlaceOptions {
  disk: string;
  region: string;
  /** The disk's control API (`archilControl`). The place holds it; no instance ever does. */
  control: SupervisorControl;
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
const requestName = (attempt: number): string => {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new PlaceError("INVALID_ARGUMENT", `attempt ${attempt} is not a count from 1`);
  return `kill-${attempt}.json`;
};

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
    const killed = new Map<PlaceRunner, () => void>();
    let resolver = pathlessResolver(control);
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
        start: (r, token, attempt) => host.start(r, token, { attempt: attempt?.attempt ?? order.gen, env: order.env }),
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
        return { record, delegations: delegations.map(({ clientId, inodeId, path, isOrphaned, isPending }) => ({ clientId, inodeId, path, isOrphaned, isPending })) };
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
