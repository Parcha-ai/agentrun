#!/usr/bin/env node
// pi-durable-disk: run an instance on a local directory, and read a run's status.
//   run        the instance its host starts: openDurableRun with an app module on `--dir` (exit 75 fenced, 76 held, 65
//              data error, 70 store head unreadable, 0 drained)
//   status     a local run's record, and whether its holder still runs
import { closeSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { JsonValue as Json } from "@earendil-works/chord";
import type { Claim, RunRef } from "./claim.ts";
import { archilEnv } from "./env.ts";
import { BoxUnavailableError, exitCodeFor, FencedError, PdaError } from "./errors.ts";
import { drain, recordWake, watchParking, type BusyState, type Parking } from "./park.ts";
import { isLoopback, readServeToken, serveRun, type RunServer } from "./serve.ts";
import { processTable, thisBoot } from "./process-table.ts";
import { localRun } from "./local-run.ts";
import { BOX_MODES, type BoxMode, parseRunRecord, RUN_JSON } from "./status.ts";
import { exitFenced, openDurableRun, type DurableRun } from "./run.ts";
import { AppError, loadApp, type AppOptions } from "./app.ts";

class UsageError extends PdaError {
  constructor(message: string) {
    super("USAGE", message, { exitCode: 2 });
  }
}

const USAGE = `usage:
  pi-durable-disk run --dir PATH --app MODULE [--id ID] [--epoch N] [--door-nonce-fd N]
                        [--heartbeat-ms N] [--lease-expiry-ms N] [--lease-margin-ms N] [--on-sigterm resume|pause]
                        [--run-as USER] [--serve PORT] [--serve-host H] [--serve-url URL]
                        [--serve-token-file F] [--park-threshold 60s] [--park-idle 60s] [--drain-timeout 25s]
                        [--box-mode bwrap|seatbelt|provider|unsandboxed|unavailable]
  pi-durable-disk status --dir PATH
durations take a unit (500ms, 30s, 1.5m, 1h); flags named -ms take bare milliseconds; a bare 0 turns off
--park-threshold`;

/**
 * Whether the lease watchdog may kill every other process in the instance's cgroup: only inside its own systemd unit,
 * whose cgroup holds nothing but the instance and its commands. Elsewhere the cgroup may be shared (a login session, an
 * agent host's service), so the watchdog kills only the instance's own command groups.
 *
 * The holder handle only claims a unit (`mode: "systemd"`, `unit`), and it arrives in an environment variable that any
 * child inherits, so /proc decides: this process's cgroup v2 path must end in `/<unit>.service`, and its parent's cgroup
 * must be another (a process that merely inherited the handle shares its parent's cgroup). When the handle claims a
 * unit that /proc does not confirm, `warning` says why, for one log line.
 */
export function watchdogOwnsCgroup(
  holder: Record<string, unknown>,
  options: { proc?: string; ppid?: number } = {},
): { owns: boolean; warning?: string } {
  if (holder.mode !== "systemd") return { owns: false };
  const proc = options.proc ?? "/proc";
  const cgroupOf = (pid: string): string | undefined => {
    try {
      return readFileSync(join(proc, pid, "cgroup"), "utf8").split("\n").find((line) => line.startsWith("0::"))?.slice(3);
    } catch {
      return undefined;
    }
  };
  const refuse = (why: string) => ({ owns: false, warning: `the watchdog will not kill the cgroup: ${why}` });
  const unit = holder.unit;
  if (typeof unit !== "string" || unit === "") return refuse("the holder names no unit");
  const own = cgroupOf("self");
  if (own === undefined) return refuse("this process has no cgroup v2 path");
  if (!own.endsWith(`/${unit}.service`)) return refuse(`this process's cgroup ${own} is not ${unit}.service`);
  const parent = cgroupOf(String(options.ppid ?? process.ppid));
  if (parent === undefined) return refuse("the parent's cgroup cannot be read");
  if (parent === own) return refuse(`the parent shares cgroup ${own}, so this process only inherited the handle`);
  return { owns: true };
}

/**
 * A duration: a number and its unit, `ms`, `s`, `m` or `h` ("500ms", "30s", "1.5m", "1h"). A bare number is refused with
 * a hint, so "90" is never silently 90 ms. A flag whose name carries its unit (`bareMs`, the `-ms` flags) takes a bare
 * number as milliseconds; a flag whose 0 turns its feature off (`zeroOff`) also takes a bare `0`.
 */
export function parseDuration(text: string, rule: DurationRule = {}): number {
  const t = text.trim();
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(t);
  if (!m) throw new UsageError(`not a duration: "${text}": a number and its unit (ms, s, m or h), e.g. 90s`);
  if (m[2] === undefined) {
    if (rule.bareMs) return Math.round(Number(m[1]));
    if (rule.zeroOff && Number(m[1]) === 0) return 0;
    throw new UsageError(`not a duration: "${text}": give a unit, e.g. ${t}s or ${t}ms`);
  }
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"]);
}

/** How a duration flag reads a bare number: as milliseconds (`bareMs`), or a bare `0` as off (`zeroOff`); otherwise never. */
export type DurationRule = { readonly bareMs?: boolean; readonly zeroOff?: boolean };

/** Every duration flag, with its rule. The `-ms` flags carry their unit in their name. A bare `0` turns off parking (`--park-threshold`). */
const DURATION_FLAGS: Readonly<Record<string, DurationRule>> = {
  "heartbeat-ms": { bareMs: true },
  "lease-expiry-ms": { bareMs: true },
  "lease-margin-ms": { bareMs: true },
  "park-threshold": { zeroOff: true },
  "park-idle": {},
  "drain-timeout": {},
};

/** A duration flag's value in milliseconds, by the flag's rule; undefined when the flag is absent. */
function durationFlag(values: Record<string, unknown>, name: string): number | undefined {
  const value = values[name];
  return typeof value === "string" ? parseDuration(value, DURATION_FLAGS[name]) : undefined;
}

function parse(argv: string[], options: ParseArgsConfig["options"]) {
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    values = parseArgs({ args: argv, options, allowPositionals: false, strict: true }).values as Record<string, string | boolean | string[] | undefined>;
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  // Every duration flag given is checked here, before the command does anything with any of them.
  for (const name of Object.keys(DURATION_FLAGS)) durationFlag(values, name);
  return values;
}

/** `--run-as NAME|UID[:GID]`: the user the agent's commands run as, with its group and home from /etc/passwd when listed. */
export function runUser(spec: string, passwd = "/etc/passwd"): { uid: number; gid: number; home: string; name: string } {
  const rows = (() => {
    try {
      return readFileSync(passwd, "utf8").split("\n").map((l) => l.split(":"));
    } catch {
      return [];
    }
  })();
  const m = /^(\d+)(?::(\d+))?$/.exec(spec);
  const row = rows.find((f) => f.length >= 6 && (m ? f[2] === m[1] : f[0] === spec));
  if (!m && !row) throw new UsageError(`no such user: ${spec}`);
  const uid = m ? Number(m[1]) : Number(row![2]);
  const gid = m?.[2] !== undefined ? Number(m[2]) : row ? Number(row[3]) : uid;
  if (uid === 0) throw new UsageError("--run-as names root: the agent's commands would run as root, the owner of the run's store");
  return { uid, gid, home: row?.[5] || "/", name: row?.[0] ?? String(uid) };
}

const need = (v: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (typeof v[k] !== "string" || v[k] === "") throw new UsageError(`--${k} is required`);
};
const str = (v: unknown, fallback?: string) => (typeof v === "string" ? v : fallback);
const emit = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);

// ---- run ---------------------------------------------------------------------------------------------------------------

/**
 * The instance its host starts: openDurableRun on the local directory `--dir` with the app module's Harness options
 * (src/app.ts), the host's handle as run.json's holder, and the lease periods. The app's factory runs once the claim is
 * held (`afterClaim`, so `ctx.root` is the live directory) and the Harness opens with what it returns; a missing or throwing module, or a failed `onOpen`, is AppError (exit 1,
 * so the unit retries within systemd's start limit; a restart in place reuses the claim). A fence of any kind kills the
 * run's commands and exits 75 inside openDurableRun.
 *
 * `--serve` listens before the run opens and writes its address into the holder, so a client finds it in run.json; an
 * address that is not loopback needs `--serve-token-file` (a 0600 file holding the bearer token), and a wildcard bind
 * (0.0.0.0, ::) needs `--serve-url`, the address clients reach, which is what run.json then carries. `--park-threshold`
 * parks the run when its work only waits longer than that, and with `--serve` an idle run parks too after `--park-idle`
 * (default the threshold), since a request can wake it. `--drain-timeout` bounds the drain on SIGTERM. What happens
 * between the open and the exit is `serveUntilDone`.
 */
async function runInstance(values: Record<string, unknown>): Promise<number> {
  // The door nonce its host handed it on a descriptor of its own (--door-nonce-fd), read whole and closed before anything
  // else of it runs. Never an environment variable: a process's starting environment stays readable by its user's other
  // processes (/proc/<pid>/environ, ps -E) whatever it deletes, and every child inherits what it keeps.
  const doorNonce = readDoorNonce(values["door-nonce-fd"]);
  need(values, "dir", "app");
  const dir = resolve(str(values.dir)!);
  const ref: RunRef = { disk: "local", region: "local", id: str(values.id) ?? basename(dir) };
  const runAs = typeof values["run-as"] === "string" ? runUser(values["run-as"]) : undefined;
  if (runAs && process.getuid?.() !== 0) throw new UsageError("--run-as needs an instance that runs as root (inside a container); elsewhere run the instance as the run user");
  const onSigterm = str(values["on-sigterm"], "resume");
  if (onSigterm !== "resume" && onSigterm !== "pause") throw new UsageError("--on-sigterm is resume or pause");
  // The box this launch runs in, as the host resolved it: recorded in run.json as given (`boxMode`), never probed here.
  const boxMode = str(values["box-mode"]);
  if (boxMode !== undefined && !(BOX_MODES as readonly string[]).includes(boxMode)) throw new UsageError(`--box-mode is one of ${BOX_MODES.join(", ")}`);
  // No box to run in: refused by name (exit 78) before anything here starts, as openDurableRun refuses it.
  if (boxMode === "unavailable") throw new BoxUnavailableError();
  // A host that holds the run's claim on a record of its own (agentrun-serve's run row) hands its epoch: a local
  // directory's run then takes no owner lock and writes no run.json (openDurableRun's `epoch`).
  const epochFlag = str(values.epoch);
  if (epochFlag !== undefined && !/^\d{1,15}$/.test(epochFlag)) throw new UsageError("--epoch takes a whole number");
  const epoch = epochFlag === undefined ? undefined : Number(epochFlag);
  // Under a host's epoch stdout is the host's pipe: one that closed (its host went) loses a line (EPIPE), never the run,
  // whose next host reads its door from the record it keeps in its store.
  if (epoch !== undefined) process.stdout.on("error", () => {});
  const ms = (name: string) => durationFlag(values, name);
  const lease = { heartbeatMs: ms("heartbeat-ms"), expiryMs: ms("lease-expiry-ms"), marginMs: ms("lease-margin-ms") };
  const parkMs = ms("park-threshold") || undefined;
  const drainMs = ms("drain-timeout") ?? 0;
  const servePort = str(values.serve);
  if (servePort !== undefined && !/^\d{1,5}$/.test(servePort)) throw new UsageError("--serve takes a port number (0: any free port)");
  const serveHost = str(values["serve-host"], "127.0.0.1")!;
  const tokenFile = str(values["serve-token-file"]);
  if (servePort !== undefined && tokenFile === undefined && !isLoopback(serveHost)) throw new UsageError(`--serve-host ${serveHost} is not loopback: name a --serve-token-file`);
  const serveToken = tokenFile === undefined ? undefined : readServeToken(tokenFile);
  const log = (event: string, extra: Record<string, unknown> = {}) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, run: ref.id, ...extra })}\n`);
  // The app's factory runs once the claim is held (`afterClaim`), so `ctx.root` is the live directory whenever app code
  // runs; what it returns opens the Harness. Serve starts before the open, with the root options the factory fills in.
  let app: AppOptions | undefined;
  const rootOptions: NonNullable<AppOptions["root"]> = {};
  const holder = JSON.parse(process.env.PDA_HOLDER ?? "{}") as Record<string, Json>;
  // On a local directory nothing else knows this instance: its start ticks go into the holder, so `status --dir` tells it
  // from a later process that reuses its pid (a driver's handle already carries them).
  if (typeof holder.startTicks !== "number") holder.startTicks = startOf(process.pid) ?? null;
  const cgroup = watchdogOwnsCgroup(holder);
  if (cgroup.warning) log("cgroup not owned", { warning: cgroup.warning });
  // The server is up before the run opens (its address goes into the holder); parking starts after.
  let parking: Parking | undefined;
  let server: RunServer | undefined;
  if (servePort !== undefined) {
    const url = str(values["serve-url"]);
    server = await serveRun({ port: Number(servePort), host: serveHost, ...(url ? { url } : {}), token: serveToken, ...(doorNonce ? { proof: doorNonce } : {}), root: rootOptions, onIdle: () => parking?.check(), log: (event, detail) => log(event, detail as Record<string, unknown>) });
    holder.serve = server.url;
    // Under a host's epoch, where it serves goes to its host as the first line on stdout, before any harness or agent
    // code runs; the host proves it with the nonce (POST /door-proof) and reads no later line.
    if (epoch !== undefined) process.stdout.write(`${JSON.stringify({ event: "door", run: ref.id, epoch, pid: process.pid, serve: server.url })}\n`, () => {});
  }
  const idleMs = ms("park-idle") ?? (server ? parkMs : undefined);
  const steps: Record<string, number> = {};
  let run: DurableRun;
  try {
    run = await openDurableRun(ref, {
      // This process ends by process.exit (main, below), so its store's close checkpoints nothing: the WAL stays, and
      // whoever takes the run back next checkpoints it.
      keepWal: true,
      ...(epoch === undefined ? {} : { epoch }),
      ...(boxMode === undefined ? {} : { boxMode: boxMode as BoxMode }),
      // A local directory is its own claim.
      ...localRun(dir),
      afterClaim: async (claim) => {
        app = await loadApp(str(values.app)!, { ref, root: claim.root, work: claim.work, store: claim.store });
        const { onOpen: _onOpen, beforeResume, root: appRoot, wake: _wake, door: _door, ...harness } = app;
        Object.assign(rootOptions, appRoot ?? {});
        return { harness, ...(beforeResume ? { beforeResume } : {}) };
      },
      ...(runAs
        ? { env: (c: Claim) => archilEnv(c, { runAs: { uid: runAs.uid, gid: runAs.gid }, shellEnv: { HOME: runAs.home, USER: runAs.name, LOGNAME: runAs.name } }) }
        : {}),
      holder,
      // The door's harness children die before the exit 75: another instance may take the run, and a child left alive
      // would act on without the lease.
      // The lease is gone: the harness children die now, without waiting on the hook's abort.
      onFenced: (error) => (server ? server.stopDoor({ now: true }).catch(() => undefined).then(() => exitFenced(error)) : exitFenced(error)),
      ownCgroup: cgroup.owns,
      lease: Object.fromEntries(Object.entries(lease).filter(([, v]) => v !== undefined)),
      onStep: (step, t) => void (steps[step] = Math.round(t)),
    });
  } catch (err) {
    log(err instanceof AppError ? "app failed" : "open failed", { code: (err as PdaError).code, exitCode: exitCodeFor(err), message: (err as Error).message, steps });
    await server?.close();
    return exitCodeFor(err);
  }
  server?.attach(run, app!.door);
  log("running", { generation: run.generation, steps, ...(server ? { serve: server.url } : {}) });
  const { onOpen, wake: appWake } = app!;
  return serveUntilDone(run, onOpen, onSigterm, log, process, {
    drainMs,
    ...(server ? { server } : {}),
    ...(appWake ? { wake: appWake } : {}),
    ...(parkMs === undefined ? {} : { park: { thresholdMs: parkMs, ...(idleMs === undefined ? {} : { idleMs }) } }),
    onParking: (p) => void (parking = p),
  });
}

/** The door nonce on descriptor `fd` (`--door-nonce-fd`): read whole, then closed; undefined without the flag. */
function readDoorNonce(fd: unknown): string | undefined {
  if (fd === undefined) return undefined;
  if (typeof fd !== "string" || !/^\d{1,3}$/.test(fd) || Number(fd) < 3) throw new UsageError("--door-nonce-fd takes a descriptor number of at least 3");
  try {
    const nonce = readFileSync(Number(fd), "utf8").trim();
    if (!/^[0-9a-f]{32,128}$/.test(nonce)) throw new UsageError("--door-nonce-fd: the descriptor holds no nonce (32 to 128 hex digits)");
    return nonce;
  } finally {
    try {
      closeSync(Number(fd));
    } catch {
      // Closed already by its read's end.
    }
  }
}

/** What the instance does besides the app between its open and its exit. */
export interface InstanceLife {
  /** How long a drain waits for running work before the release; 0 (default) releases at once. */
  readonly drainMs?: number;
  /** Park the run when its work allows (`watchParking`); absent, the instance stays up through every wait. */
  readonly park?: { readonly thresholdMs: number; readonly idleMs?: number };
  /** The serve front: its open requests keep the instance up, and a park or a drain stops its submissions. */
  readonly server?: RunServer;
  /** The app's wake hook; default run.json `sleeping` with `wakeAt`. */
  readonly wake?: (run: DurableRun, at: number | null) => Promise<void>;
  /** Handed the parking watch once it runs. */
  readonly onParking?: (parking: Parking) => void;
}

/**
 * The instance's life after the run opened: the app's `onOpen` runs; the run parks when `life.park` allows (the wake
 * written, the run released, exit 0); SIGTERM or SIGINT drains and releases, and the drain's outcome is the exit code.
 * A drain stops new submissions, stops a door hook's work (`RunServer.stopDoor`: its abort, then its harness children
 * killed) and waits up to `life.drainMs` for running work; with `resume` it then writes the run
 * sleeping with its wake (the deadline its work waits for, null when idle and idle parking is on, otherwise now), so
 * the supervisor starts it again and a deploy never strands it; a wake hook that refuses falls back to a due wake.
 * `pause` seals it paused. An app that released the run itself (`run.release()`, in `onOpen` or after it) has nothing left to
 * serve: the instance exits 0 when `onOpen` returns, and a stop after that exits 0 without a drain, since the Harness is
 * closed and the run's status final. A rejection of `onOpen` is the app failing (exit 1), except once a drain or a park's release
 * began: closing the Harness under the app makes its work reject ("Session is closed"), and ending the process there
 * would cut the release short.
 */
export function serveUntilDone(
  run: Pick<DurableRun, "setStatus" | "release" | "record"> & Partial<Pick<DurableRun, "releasing">>,
  onOpen: ((run: DurableRun) => void | Promise<void>) | undefined,
  onSigterm: string | undefined,
  log: (event: string, extra?: Record<string, unknown>) => void,
  signals: Pick<NodeJS.EventEmitter, "once"> = process,
  life: InstanceLife = {},
): Promise<number> {
  // Parking and a drain with a limit read the Harness; a caller that asks for them passes the whole run.
  const durable = run as DurableRun;
  const drainMs = life.drainMs ?? 0;
  return new Promise<number>((settle) => {
    // The run's heartbeat and lease timers are unref'd (a library caller's process may end); an instance stays up, with or
    // without work, until it parks, drains or fails, so an ended event loop never exits it without a release.
    const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
    const done = (code: number) => {
      clearInterval(keepAlive);
      settle(code);
    };
    let releasing = false;
    let parking: Parking | undefined;
    const sleeping = (at: number | null) => run.setStatus("sleeping", { reason: "drained" }, { wakeAt: at === null ? null : new Date(at).toISOString() });
    // The app released the run: wait for its release to end (a second `release()` joins it) and leave.
    const leaveReleased = async (event: Record<string, unknown>) => {
      try {
        // The door's harness children go before the instance does.
        await life.server?.stopDoor().catch(() => undefined);
        await run.release();
        log("released", { ...event, record: run.record as unknown as Json });
        done(0);
      } catch (err) {
        log("release failed", { code: (err as PdaError).code, message: (err as Error).message });
        done(exitCodeFor(err));
      }
    };
    const shutdown = async (signal: string) => {
      if (releasing) return;
      releasing = true;
      log("draining", { signal, onSigterm, drainMs });
      if (run.releasing === true) return leaveReleased({ drained: "released" });
      try {
        if (await parking?.stop()) return done(0);
        life.server?.pause();
        await life.server?.stopDoor();
        const state: BusyState = drainMs > 0 ? await drain(durable, { deadline: Date.now() + drainMs }) : { kind: "busy" };
        if (onSigterm === "resume") {
          const at = state.kind === "waiting" ? state.until : state.kind === "idle" && life.park?.idleMs !== undefined ? null : Date.now();
          await (life.wake ? life.wake(durable, at) : sleeping(at)).catch((err: unknown) => {
            if (err instanceof FencedError || durable.fenced) throw err;
            return sleeping(Date.now());
          });
        }
        await run.release();
        log("released", { drained: state.kind, record: run.record as unknown as Json });
        done(0);
      } catch (err) {
        log("release failed", { code: (err as PdaError).code, message: (err as Error).message });
        done(exitCodeFor(err));
      }
    };
    signals.once("SIGTERM", () => void shutdown("SIGTERM"));
    signals.once("SIGINT", () => void shutdown("SIGINT"));
    if (life.park) {
      parking = watchParking(durable, {
        ...life.park,
        // The release follows the wake at once, so from here on the app's work may reject under it.
        wake: async (_target, at) => {
          await (life.wake ?? recordWake)(durable, at);
          releasing = true;
          // A parked instance exits: the door's harness children go first.
          await life.server?.stopDoor();
        },
        keepAwake: () => (life.server?.active ?? 0) > 0,
        ...(life.server ? { quiesce: () => life.server!.pause() } : {}),
        log: (event, detail) => log(event, detail),
      });
      life.onParking?.(parking);
      parking.parked.then(
        (parked) => {
          log("parked", { wakeAt: parked.wakeAt === null ? null : new Date(parked.wakeAt).toISOString(), blocked: parked.blocked, generation: durable.generation });
          done(0);
        },
        (err: unknown) => {
          log("park release failed", { code: (err as PdaError).code, message: (err as Error).message });
          done(exitCodeFor(err));
        },
      );
    }
    // onOpen may return at once (work submitted) or run for the instance's life.
    Promise.resolve()
      .then(() => onOpen?.(durable))
      .then(() => {
        if (releasing || run.releasing !== true) return;
        releasing = true;
        void leaveReleased({ drained: "app" });
      })
      .catch((err: unknown) => {
        if (releasing) return;
        const e = new AppError(`onOpen failed: ${(err as Error).message}`, { cause: err });
        log("app failed", { code: e.code, message: e.message });
        void (life.server?.stopDoor({ now: true }).catch(() => undefined) ?? Promise.resolve()).then(() => done(exitCodeFor(e)));
      });
  });
}

// ---- status ------------------------------------------------------------------------------------------------------------

async function status(values: Record<string, unknown>): Promise<number> {
  need(values, "dir");
  return localStatus(resolve(str(values.dir)!));
}

/**
 * `status --dir PATH`: `run.json` read from the directory, and whether its holder is still the process that claimed it:
 * `running` when it is this boot's and its pid is alive with the start ticks the holder recorded (a later process that
 * reuses the pid has others), `stopped` when it is not, `gone` from another boot, and `unknown` when the holder recorded no
 * start ticks (a run opened by a library caller) and its pid is alive.
 */
function localStatus(dir: string): number {
  let text: string;
  try {
    text = readFileSync(join(dir, RUN_JSON), "utf8");
  } catch (err) {
    throw new UsageError(`no run in ${dir}: ${(err as Error).message}`);
  }
  const run = parseRunRecord(text);
  let holderStatus: string | null = null;
  const holder = run.holder;
  if (holder) {
    // A read that failed (sysctl or ps on macOS) is no exit: it says `unknown`, never `gone` or `stopped`.
    const boot = thisBoot();
    const ticks = startOf(Number(holder.pid));
    if (boot === null) holderStatus = "unknown";
    else if (holder.bootId !== boot) holderStatus = "gone";
    else if (ticks === undefined) holderStatus = "unknown";
    else if (typeof holder.startTicks === "number") holderStatus = ticks === holder.startTicks ? "running" : "stopped";
    else holderStatus = ticks === null ? "stopped" : "unknown";
  }
  emit({ run: run.run, dir, runJson: run as unknown as Json, holderStatus });
  return 0;
}

/** A live process's start (null: no such process, or a zombie), or undefined when the process table cannot be read. */
function startOf(pid: number): number | null | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    return processTable().snapshot().info(pid)?.start ?? null;
  } catch {
    return undefined;
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help" || (command !== undefined && rest[0] === "--help")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    switch (command) {
      case "run":
        return await runInstance(
          parse(rest, {
            id: { type: "string" },
            dir: { type: "string" },
            app: { type: "string" },
            "heartbeat-ms": { type: "string" },
            "lease-expiry-ms": { type: "string" },
            "lease-margin-ms": { type: "string" },
            "on-sigterm": { type: "string" },
            serve: { type: "string" },
            "serve-host": { type: "string" },
            "serve-token-file": { type: "string" },
            "serve-url": { type: "string" },
            "park-threshold": { type: "string" },
            "park-idle": { type: "string" },
            "drain-timeout": { type: "string" },
            "run-as": { type: "string" },
            "box-mode": { type: "string" },
            epoch: { type: "string" },
            "door-nonce-fd": { type: "string" },
          }),
        );
      case "status":
        return await status(parse(rest, { dir: { type: "string" } }));
      default:
        throw new UsageError(command ? `unknown command ${command}` : "no command");
    }
  } catch (err) {
    if (err instanceof UsageError) process.stderr.write(`${err.message}\n${USAGE}\n`);
    else process.stderr.write(`${JSON.stringify({ error: (err as PdaError).code ?? "ERROR", message: (err as Error).message })}\n`);
    return exitCodeFor(err);
  }
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
