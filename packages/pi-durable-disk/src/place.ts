// Places: where one run lives, and how its instance starts, is killed and comes back. A supervisor that decides when to
// kill (agentrun's reference demo) is the same for every place; the place decides how. `localPlace` runs the instance on
// a directory of this machine (`run --dir`, no disk and no key); `archilPlace` runs it on an Archil disk through a host
// driver, mints each attempt's mount token itself and takes the run over after a kill. The types match the reference's
// place seam (examples/reference/place.ts) structurally. The supervisor reads nothing under the run's directory: the
// outcome, the run's record and its delegations come through the place.
import { spawn } from "node:child_process";
import { extname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Delegation } from "disk";
import { DEFAULT_MOUNT_ROOT, findDelegations, mintMountToken, removeMountToken, runPath, type RunRef } from "./claim.ts";
import { PdaError } from "./errors.ts";
import { readRunRecord, type RunRecord } from "./status.ts";
import {
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
/** What the supervisor hands a place factory: the run's paths as it computed them, and how to take the boxes the run made. */
export type PlaceContext = { paths: PlacePaths; self?: string; destroyBoxes?: () => void | Promise<void> };

export interface Place {
  /** `local` or `archil`, for the recording's lines. */
  readonly name: string;
  readonly paths: PlacePaths;
  /** A place whose instance opens a claim mints each attempt's mount token: the supervisor passes it as the runner's stdin, never in argv or env. */
  token?(attempt: number): string | undefined | Promise<string | undefined>;
  /** What this place can lose. */
  readonly kills: ReadonlyArray<PlaceKill>;
  start(order: RunnerOrder): Promise<PlaceRunner>;
  /** Takes the runner away abruptly, as a crash would. Safe on a runner that is already gone. */
  kill(runner: PlaceRunner, kind: PlaceKill): Promise<void>;
  status?(): Promise<PlaceStatus>;
  /** Kills `last` if it still runs, then starts the next runner. */
  recover(last: PlaceRunner, kind: PlaceKill, order: RunnerOrder): Promise<PlaceRecovery>;
  checkpoint?(): Promise<{ taken: boolean; heldBy?: string }>;
  move?(to: Place): Promise<Record<string, unknown>>;
  /** Lets the run go: stops what still runs and removes what the place made for it (tokens), never the run's directory. */
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
const STDERR_KEEP = 600;
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
    const boxesTaken = new Set<PlaceRunner>();

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
          alive.delete(runner);
          outcome = outcomeLine(partial) ?? outcome;
          const fallback = outcome ? undefined : outcomeOf(await readRunRecord(root).catch(() => undefined));
          const report = outcome ?? fallback;
          settle({ exit: ended.signal ?? ended.code, signal: ended.signal, ...(report ? { outcome: report } : {}), stderr: stderr.trim().slice(0, STDERR_KEEP) });
        };
        child.once("exit", (code, signal) => {
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
      // Once per runner: a supervisor that kills and then recovers the same runner takes its boxes once.
      if (kind === "box" && !boxesTaken.has(runner)) {
        boxesTaken.add(runner);
        await ctx.destroyBoxes?.();
      }
    };

    return {
      name: "local",
      paths,
      kills: ctx.destroyBoxes ? ["process", "box"] : ["process"],
      start,
      kill,
      status: async () => ({ record: (await readRunRecord(root)) ?? null }),
      recover: async (last, kind, order) => {
        await kill(last, kind);
        return { runner: await start(order) };
      },
      release: async () => {
        await Promise.all([...alive.keys()].map((runner) => kill(runner, "process")));
      },
    };
  };
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
}

type Minted = { token: string; identifier: string; nickname: string; removed: boolean };

/**
 * The run on an Archil disk, its instance run by a host driver. `token(attempt)` mints the attempt's mount token through
 * the place's control, and the runner it is handed to mounts with it. A start is `ensureRunning` (it creates the run's
 * directory with `ensure.create` and writes the start mark) with that token and the order's environment. A kill is the
 * driver's `kill`: `process` or `box`, whichever the driver takes. A recovery is the takeover: the dead holder's
 * delegations revoked (its lease counts as expired, since the place killed it) and the next instance started, which
 * `revoked` and `ms` report. A runner ends when the driver no longer reports it running, or when the place killed it; its
 * outcome is `run.json` read over S3, with `code`, `message`, `record` and `storeSha256` from the detail of the last
 * status the app set. `release` stops every instance it started and removes every token it minted; the run's directory
 * stays (`deleteRunTree`).
 */
export function archilPlace(options: ArchilPlaceOptions): (ctx: PlaceContext) => Place {
  const { control, host } = options;
  const pollMs = options.pollMs ?? 1_000;
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
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
          // HOST_START_FAILED: ensureRunning removed the token. Anything else failed before the token was used.
          if ((err as PdaError).code === "HOST_START_FAILED") m.removed = true;
          else await drop(m).catch(() => {});
          throw err;
        }
        if (result.action === "started") {
          if (result.adopted) m.removed = true;
          handles.push(result.handle);
          const w = watch(result.handle);
          const mark = result.startMark ? await readStartMark(control, ref.id).catch(() => null) : null;
          const runner: PlaceRunner = { epoch: mark?.generation ?? order.gen, exited: w.exited };
          killed.set(runner, w.kill);
          handleOf.set(runner, result.handle);
          // A runner that ended on its own is gone: a later kill of it is a no-op.
          const forget = () => void killed.delete(runner);
          w.exited.then(forget, forget);
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
      }
      await runner.exited;
    };

    return {
      name: "archil",
      paths,
      kills: host.kill && host.kills ? [host.kills] : [],
      token: async (attempt) => (await mint(attempt)).token,
      start: async (order) => (await ensure(order, false)).runner,
      kill,
      status: async () => {
        const [record, delegations] = await Promise.all([readRunStatus(control, ref.id), findDelegations(control, ref.id)]);
        return { record, delegations: delegations.map(({ clientId, inodeId, path, isOrphaned, isPending }) => ({ clientId, inodeId, path, isOrphaned, isPending })) };
      },
      recover: async (last, kind, order) => {
        if (killed.has(last)) await kill(last, kind);
        const { result, runner, ms } = await ensure(order, true);
        return { runner, revoked: result.action === "started" ? result.revoked : [], ms };
      },
      release: async () => {
        const failed: string[] = [];
        for (const handle of handles.splice(0)) {
          await host.stop(handle).catch((err: unknown) => failed.push(`stop ${String(handle.name ?? handle.driver)}: ${(err as Error).message}`));
        }
        for (const m of minted.values()) {
          await drop(m).catch((err: unknown) => failed.push(`token ${m.nickname}: ${(err as Error).message}`));
        }
        if (failed.length) throw new PlaceError("RELEASE_FAILED", `releasing ${runPath(ref.id)} left: ${failed.join("; ")}`);
      },
    };
  };
}
