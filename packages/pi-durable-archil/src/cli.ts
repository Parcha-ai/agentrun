#!/usr/bin/env node
// pi-durable-archil: run an instance, supervise runs, read a run's status, release a run's mount on this host.
//   run        the instance a host driver starts: openDurableRun with an app module (exit 75 fenced, 76 held, 65 data
//              error, 70 store head unreadable, 0 drained)
//   supervise  ensureRunning for each run, once or `--every 30s`; `--check` proves this host's fence first
//   status     run.json over S3, the run's delegations, and the holder's state if this host can see it
//   release    unmount the run's mount on this host (flush, check the delegation in; a dead mount is cleaned)
//   fork       copy a released, sealed run into a new run; its first open is generation 1
// The API key is read from the environment variable named by `--api-key-env` (default ARCHIL_API_KEY) and only by the
// supervisor commands; `run` never needs it and a host driver never passes it on.
import { closeSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { ARCHIL_SCOPED, DEFAULT_MOUNT_ROOT, runPath, TOKEN_PREFIX, unmountClaim, type Claim, type RunRef } from "./claim.ts";
import { archilEnv } from "./env.ts";
import { exitCodeFor, FencedError, PdaError } from "./errors.ts";
import { fork } from "./fork.ts";
import { drain, recordWake, watchParking, type BusyState, type Parking } from "./park.ts";
import { isLoopback, readServeToken, serveRun, type RunServer } from "./serve.ts";
import { dockerHost } from "./hosts/docker.ts";
import { localHost } from "./hosts/local-host.ts";
import {
  checkHost,
  CONTROL_TIMEOUT_MS,
  readRunStatus,
  superviseRuns,
  sweepTokens,
  withTimeouts,
  type CheckControl,
  type HostDriver,
  type Json,
  type SupervisorControl,
  type TokenUser,
} from "./supervise.ts";
import { openDurableRun, type DurableRun } from "./run.ts";
import { AppError, loadApp, type AppOptions } from "./app.ts";

class UsageError extends PdaError {
  constructor(message: string) {
    super("USAGE", message, { exitCode: 2 });
  }
}

const USAGE = `usage:
  pi-durable-archil run --disk D --region R --id ID --app MODULE [--mount-root DIR] [--archil BIN]
                        [--heartbeat-ms N] [--lease-expiry-ms N] [--lease-margin-ms N] [--on-sigterm resume|pause]
                        [--token-stdin] [--run-as USER] [--serve PORT] [--serve-host H] [--serve-url URL]
                        [--serve-token-file F] [--park-threshold 60s] [--park-idle 60s] [--drain-timeout 25s]
  pi-durable-archil supervise --disk D --region R (--id ID ... | --all) [--every 30s] [--check]
                        [--host local|docker] [--driver systemd|child] [--mount-root DIR] [--host-name NAME] [--unit-prefix P]
                        [--user U] [--group G] [--app MODULE] [--run-arg ARG ...] [--lease-expiry 90s] [--stonith-timeout 30s]
                        [--start-grace 90s] [--start-backoff-max 10m] [--stop-timeout 30s] [--token-ttl 24h] [--token-prefix P] [--demand] [--create] [--env K=V ...] [--log-dir DIR]
                        [--archil BIN] [--control-timeout 10s] [--sweep-tokens] [--token-grace 15m]
                        [--park-threshold 60s] [--api-key-env NAME]
                        with --host docker: --image IMAGE [--app-root DIR] [--fleet F] [--name-prefix P] [--run-as USER]
                        [--docker-arg ARG ...] [--apparmor auto|PROFILE|none] [--docker BIN]
  pi-durable-archil supervise --check --disk D --region R [--mount-root DIR] [--user U] [--group G] [--check-id-prefix P]
  pi-durable-archil status --disk D --region R --id ID [--host-name NAME] [--api-key-env NAME] [--docker BIN]
  pi-durable-archil release --id ID [--mount-root DIR]
  pi-durable-archil fork --disk D --region R --id ID --new-id NEW [--mount-root DIR] [--archil BIN] [--token-prefix P]
                        [--api-key-env NAME]`;

/** "30s", "500ms", "2m", "1h", or plain milliseconds. */
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

export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!m) throw new UsageError(`not a duration: ${text}`);
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "ms") as "ms" | "s" | "m" | "h"]);
}

function parse(argv: string[], options: ParseArgsConfig["options"]) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false, strict: true }).values as Record<string, string | boolean | string[] | undefined>;
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

/** A user or group name or number, as a number (from /etc/passwd or /etc/group). */
function idOf(value: string | undefined, file: "/etc/passwd" | "/etc/group", fallback: number): number {
  if (value === undefined) return fallback;
  if (/^\d+$/.test(value)) return Number(value);
  const row = readFileSync(file, "utf8").split("\n").map((l) => l.split(":")).find((f) => f[0] === value);
  if (!row) throw new UsageError(`no such ${file === "/etc/passwd" ? "user" : "group"}: ${value}`);
  return Number(row[2]);
}
const ownerOf = (values: Record<string, unknown>) => ({
  uid: idOf(str(values.user), "/etc/passwd", process.getuid?.() ?? 0),
  gid: idOf(str(values.group), "/etc/group", process.getgid?.() ?? 0),
});

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
  if (uid === 0) throw new UsageError("--run-as names root: the agent's commands would run as root, next to the archil daemon that holds the mount token");
  return { uid, gid, home: row?.[5] || "/", name: row?.[0] ?? String(uid) };
}

const need = (v: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (typeof v[k] !== "string" || v[k] === "") throw new UsageError(`--${k} is required`);
};
const str = (v: unknown, fallback?: string) => (typeof v === "string" ? v : fallback);
const emit = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);

/** The disk's control API for the supervisor, plus the two lists only the disk record carries (users, clients). */
async function control(values: Record<string, unknown>): Promise<SupervisorControl & CheckControl & { listUsers(): Promise<TokenUser[]> }> {
  const name = str(values["api-key-env"], "ARCHIL_API_KEY")!;
  const apiKey = process.env[name];
  if (!apiKey) throw new UsageError(`no API key in $${name}`);
  const { configure, getDisk } = await import("disk");
  configure({ apiKey, region: str(values.region)! });
  const id = str(values.disk)!;
  const disk = await getDisk(id);
  return {
    getObject: (key) => disk.getObject(key),
    headObject: (key) => disk.headObject(key),
    putObject: (key, body, options) => disk.putObject(key, body, options),
    addUser: (user) => disk.addUser(user),
    removeUser: (type, identifier) => disk.removeUser(type, identifier),
    listDelegations: () => disk.listDelegations(),
    revokeDelegation: (d) => disk.revokeDelegation(d),
    exec: (command) => disk.exec(command),
    listObjects: (prefix, options) => disk.listObjects(prefix, options),
    deleteObjects: (keys, options) => disk.deleteObjects(keys, options),
    listUsers: async () => (await getDisk(id)).authorizedUsers ?? [],
  };
}

// ---- run ---------------------------------------------------------------------------------------------------------------

/**
 * The mount token from stdin, after which stdin is closed: the token is reusable for a day, and a process of the run's
 * user could otherwise reopen it through /proc/<pid>/fd/0. A restart in place reads nothing (the driver emptied the file)
 * and needs nothing: acquire reuses the live mount without the token. A fresh mount with the placeholder is refused.
 */
async function readToken(values: Record<string, unknown>): Promise<string> {
  if (!values["token-stdin"]) return "none";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    closeSync(0);
    openSync("/dev/null", "r");
  } catch {
    // already closed
  }
  return text.trim() || "none";
}

/**
 * The instance a host driver starts: openDurableRun with the app module's Harness options (src/app.ts), the
 * driver's handle as run.json's holder, the mount token from stdin (read once, then stdin is closed), and the lease
 * periods. The app loads before anything mounts; a missing or throwing module, or a failed `onOpen`, is AppError (exit 1,
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
  need(values, "disk", "region", "id", "app");
  const ref: RunRef = { disk: str(values.disk)!, region: str(values.region)!, id: str(values.id)! };
  const runAs = typeof values["run-as"] === "string" ? runUser(values["run-as"]) : undefined;
  if (runAs && process.getuid?.() !== 0) throw new UsageError("--run-as needs an instance that runs as root (inside a container); elsewhere run the instance as the run user");
  const onSigterm = str(values["on-sigterm"], "resume");
  if (onSigterm !== "resume" && onSigterm !== "pause") throw new UsageError("--on-sigterm is resume or pause");
  const ms = (name: string) => (typeof values[name] === "string" ? parseDuration(values[name] as string) : undefined);
  const lease = { heartbeatMs: ms("heartbeat-ms"), expiryMs: ms("lease-expiry-ms"), marginMs: ms("lease-margin-ms") };
  const parkMs = ms("park-threshold") || undefined;
  const drainMs = ms("drain-timeout") ?? 0;
  const servePort = str(values.serve);
  if (servePort !== undefined && !/^\d{1,5}$/.test(servePort)) throw new UsageError("--serve takes a port number (0: any free port)");
  const serveHost = str(values["serve-host"], "127.0.0.1")!;
  const tokenFile = str(values["serve-token-file"]);
  if (servePort !== undefined && tokenFile === undefined && !isLoopback(serveHost)) throw new UsageError(`--serve-host ${serveHost} is not loopback: name a --serve-token-file`);
  const serveToken = tokenFile === undefined ? undefined : readServeToken(tokenFile);
  const mountRoot = str(values["mount-root"], DEFAULT_MOUNT_ROOT)!;
  const root = join(mountRoot, runPath(ref.id));
  const log = (event: string, extra: Record<string, unknown> = {}) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, run: ref.id, ...extra })}\n`);
  let app: AppOptions;
  try {
    app = await loadApp(str(values.app)!, { ref, root, work: join(root, "work"), store: join(root, "store") });
  } catch (err) {
    log("app failed", { code: (err as PdaError).code, message: (err as Error).message });
    return exitCodeFor(err);
  }
  const { onOpen, root: rootOptions, wake: appWake, ...harness } = app;
  const holder = JSON.parse(process.env.PDA_HOLDER ?? "{}") as Record<string, Json>;
  const cgroup = watchdogOwnsCgroup(holder);
  if (cgroup.warning) log("cgroup not owned", { warning: cgroup.warning });
  // The server is up before the run opens (its address goes into the holder); parking starts after.
  let parking: Parking | undefined;
  let server: RunServer | undefined;
  if (servePort !== undefined) {
    const url = str(values["serve-url"]);
    server = await serveRun({ port: Number(servePort), host: serveHost, ...(url ? { url } : {}), token: serveToken, root: rootOptions, onIdle: () => parking?.check() });
    holder.serve = server.url;
  }
  const idleMs = ms("park-idle") ?? (server ? parkMs : undefined);
  const steps: Record<string, number> = {};
  let run: DurableRun;
  try {
    run = await openDurableRun(ref, {
      mountToken: await readToken(values),
      mountRoot,
      host: { archil: str(values.archil) },
      harness,
      ...(runAs
        ? { env: (c: Claim) => archilEnv(c, { runAs: { uid: runAs.uid, gid: runAs.gid }, shellEnv: { HOME: runAs.home, USER: runAs.name, LOGNAME: runAs.name } }) }
        : {}),
      holder,
      ownCgroup: cgroup.owns,
      lease: Object.fromEntries(Object.entries(lease).filter(([, v]) => v !== undefined)),
      onStep: (step, t) => void (steps[step] = Math.round(t)),
    });
  } catch (err) {
    log("open failed", { code: (err as PdaError).code, exitCode: exitCodeFor(err), message: (err as Error).message, steps });
    await server?.close();
    return exitCodeFor(err);
  }
  server?.attach(run);
  log("running", { generation: run.generation, steps, ...(server ? { serve: server.url } : {}) });
  return serveUntilDone(run, onOpen, onSigterm, log, process, {
    drainMs,
    ...(server ? { server } : {}),
    ...(appWake ? { wake: appWake } : {}),
    ...(parkMs === undefined ? {} : { park: { thresholdMs: parkMs, ...(idleMs === undefined ? {} : { idleMs }) } }),
    onParking: (p) => void (parking = p),
  });
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
 * A drain stops new submissions and waits up to `life.drainMs` for running work; with `resume` it then writes the run
 * sleeping with its wake (the deadline its work waits for, null when idle and idle parking is on, otherwise now), so
 * the supervisor starts it again and a deploy never strands it; a wake hook that refuses falls back to a due wake.
 * `pause` seals it paused. A rejection of `onOpen` is the app failing (exit 1), except once a drain or a park's release
 * began: closing the Harness under the app makes its work reject ("Session is closed"), and ending the process there
 * would cut the release before its unmount (a container's FUSE daemon dies with the process, leaving the delegation
 * orphaned).
 */
export function serveUntilDone(
  run: Pick<DurableRun, "setStatus" | "release" | "record">,
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
    const shutdown = async (signal: string) => {
      if (releasing) return;
      releasing = true;
      log("draining", { signal, onSigterm, drainMs });
      try {
        if (await parking?.stop()) return done(0);
        life.server?.pause();
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
      .catch((err: unknown) => {
        if (releasing) return;
        const e = new AppError(`onOpen failed: ${(err as Error).message}`, { cause: err });
        log("app failed", { code: e.code, message: e.message });
        done(exitCodeFor(e));
      });
  });
}

// ---- supervise, status, release ----------------------------------------------------------------------------------------

/**
 * The flags every instance this supervisor starts gets after `run`: `--app MODULE` (made absolute, since the unit's working
 * directory is not the supervisor's) and any `--run-arg`, in that order.
 */
export function instanceRunArgs(values: Record<string, unknown>): string[] {
  return [...(typeof values.app === "string" ? ["--app", resolve(values.app)] : []), ...((values["run-arg"] as string[] | undefined) ?? [])];
}

/** `--park-threshold` for either driver: absent keeps the driver's default, 0 turns parking off. */
const parkThreshold = (values: Record<string, unknown>): { parkThresholdMs?: number | null } =>
  values["park-threshold"] === undefined ? {} : { parkThresholdMs: parseDuration(str(values["park-threshold"])!) || null };

function driverFrom(values: Record<string, unknown>): HostDriver {
  const env = Object.fromEntries(
    ((values.env as string[] | undefined) ?? []).map((kv) => {
      const i = kv.indexOf("=");
      if (i <= 0) throw new UsageError(`--env takes KEY=VALUE, got ${kv}`);
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const host = str(values.host, "local");
  if (host === "docker") {
    if (typeof values.image !== "string" || !values.image) throw new UsageError("--host docker needs --image");
    const apparmor = str(values.apparmor);
    return dockerHost({
      image: values.image,
      docker: str(values.docker),
      fleet: str(values.fleet),
      namePrefix: str(values["name-prefix"]),
      mountRoot: str(values["mount-root"]),
      app: str(values.app),
      appRoot: str(values["app-root"]),
      runArgs: (values["run-arg"] as string[] | undefined) ?? [],
      runAs: str(values["run-as"]),
      env,
      dockerArgs: (values["docker-arg"] as string[] | undefined) ?? [],
      apparmor: apparmor === "none" ? false : apparmor,
      note: (line) => emit({ event: "docker", note: line }),
      stopTimeoutMs: values["stop-timeout"] ? parseDuration(str(values["stop-timeout"])!) : undefined,
      ...parkThreshold(values),
    });
  }
  if (host !== "local") throw new UsageError(`--host is local or docker, got ${host}`);
  const runArgs = instanceRunArgs(values);
  return localHost({
    env,
    mode: str(values.driver, "systemd") as "systemd" | "child",
    mountRoot: str(values["mount-root"]),
    hostName: str(values["host-name"]),
    unitPrefix: str(values["unit-prefix"]),
    user: str(values.user),
    group: str(values.group),
    runArgs,
    stopTimeoutMs: values["stop-timeout"] ? parseDuration(str(values["stop-timeout"])!) : undefined,
    restart: values["no-restart"] ? false : undefined,
    logDir: str(values["log-dir"]),
    archil: str(values.archil),
    ...parkThreshold(values),
  });
}


/** Root executes the archil wrapper through sudo, so anyone who can write it is root. */
function wrapperWarnings(path: string): string[] {
  let st: { uid: number; mode: number };
  try {
    st = statSync(path);
  } catch {
    return [`${path} does not exist`];
  }
  const out: string[] = [];
  if (st.uid !== 0) out.push(`${path} is owned by uid ${st.uid}, not root, and root runs it through sudo`);
  if (st.mode & 0o022) out.push(`${path} is writable by its group or others (mode ${(st.mode & 0o777).toString(8)})`);
  return out;
}

async function supervise(values: Record<string, unknown>): Promise<number> {
  need(values, "disk", "region");
  const docker = str(values.host, "local") === "docker";
  if (!docker && str(values.host, "local") !== "local") throw new UsageError(`--host is local or docker, got ${str(values.host)}`);
  if (docker && values.check) throw new UsageError("--check proves this host's own mounts; with --host docker the containers mount, so it does not apply");
  if (docker && (typeof values.image !== "string" || !values.image)) throw new UsageError("--host docker needs --image");
  const disk = await control(values);
  const controlTimeoutMs = values["control-timeout"] ? parseDuration(str(values["control-timeout"])!) : CONTROL_TIMEOUT_MS;
  if (values.check) {
    const report = await checkHost({
      control: disk,
      disk: str(values.disk)!,
      region: str(values.region)!,
      mountRoot: str(values["mount-root"], DEFAULT_MOUNT_ROOT)!,
      owner: ownerOf(values),
      tokenPrefix: str(values["token-prefix"]),
      idPrefix: str(values["check-id-prefix"]),
      controlTimeoutMs,
      onResource: (kind, id, detail) => emit({ event: "check-resource", kind, id, detail }),
    });
    emit({ event: "check", ...report, warnings: str(values.driver, "systemd") === "systemd" ? wrapperWarnings(str(values.archil, ARCHIL_SCOPED)!) : [] });
    if (!report.ok) return 1;
    if (!values.id && !values.all) return 0;
  }
  const ids = async (): Promise<string[]> => {
    if (!values.all) return (values.id as string[] | undefined) ?? [];
    const listed = await withTimeouts(disk, controlTimeoutMs).listObjects("runs/");
    return listed.commonPrefixes.map((p) => p.replace(/^runs\//, "").replace(/\/$/, "")).filter(Boolean);
  };
  if (!values.id && !values.all && !values["sweep-tokens"]) throw new UsageError("name runs with --id or --all (or only --sweep-tokens)");
  const host = driverFrom(values);
  const opts = {
    control: disk,
    leaseExpiryMs: values["lease-expiry"] ? parseDuration(str(values["lease-expiry"])!) : undefined,
    stonithTimeoutMs: values["stonith-timeout"] ? parseDuration(str(values["stonith-timeout"])!) : undefined,
    startGraceMs: values["start-grace"] !== undefined ? parseDuration(str(values["start-grace"])!) : undefined,
    startBackoffMaxMs: values["start-backoff-max"] !== undefined ? parseDuration(str(values["start-backoff-max"])!) : undefined,
    tokenTtl: str(values["token-ttl"]),
    tokenPrefix: str(values["token-prefix"]),
    demand: Boolean(values.demand),
    // In a container the instance is root and its commands are the run user: the run's root belongs to root, and the
    // instance gives `work/` to the run user (run --run-as).
    create: values.create ? (docker && values.user === undefined ? { uid: 0, gid: 0 } : ownerOf(values)) : undefined,
    controlTimeoutMs,
  };
  let failures = 0;
  const tick = async () => {
    const refs = (await ids()).map((id) => ({ disk: str(values.disk)!, region: str(values.region)!, id }));
    for (const line of await superviseRuns(refs, host, opts)) {
      if (line.action === "error") failures++;
      emit(line);
      // One line per backoff step: a start that follows failed ones, with the grace it now gets.
      if (line.action === "started" && line.failures > 0) emit({ event: "start-backoff", run: line.run, failures: line.failures, lastExit: line.lastExit, graceMs: line.graceMs });
    }
    // Token users no live mount needs: those of released runs past the grace, and with --sweep-tokens the expired ones.
    // A failure here costs this line only; the runs were decided above.
    const timed = withTimeouts(disk, controlTimeoutMs);
    const r = await sweepTokens({
      listUsers: () => timed.listUsers(),
      control: timed,
      prefix: str(values["token-prefix"], TOKEN_PREFIX)!,
      runs: values.id ? refs.map((x) => x.id) : undefined,
      expired: Boolean(values["sweep-tokens"]),
      graceMs: values["token-grace"] ? parseDuration(str(values["token-grace"])!) : undefined,
    }).catch((e: unknown) => ({ removed: [], failed: [{ identifier: "*", error: (e as Error).message }] }));
    if (r.removed.length || r.failed.length) emit({ event: "token-sweep", ...r });
  };
  if (!values.every) {
    await tick();
    return failures ? 1 : 0;
  }
  const every = parseDuration(str(values.every)!);
  let stopped = false;
  process.once("SIGTERM", () => (stopped = true));
  process.once("SIGINT", () => (stopped = true));
  while (!stopped) {
    const t0 = performance.now();
    // A tick that fails as a whole (the run listing, say) is one line; the loop goes on.
    await tick().catch((err: unknown) => emit({ event: "tick-failed", error: (err as PdaError).code ?? "ERROR", message: (err as Error).message }));
    for (let left = every - (performance.now() - t0); left > 0 && !stopped; left -= 100) await new Promise((r) => setTimeout(r, Math.min(100, left)));
  }
  return 0;
}

async function status(values: Record<string, unknown>): Promise<number> {
  need(values, "disk", "region", "id");
  const disk = await control(values);
  const id = str(values.id)!;
  const run = await readRunStatus(disk, id);
  const { findDelegations } = await import("./claim.ts");
  const delegations = await findDelegations(disk, id);
  let holderStatus: string | null = null;
  let container: Json = null;
  if (run?.holder?.driver === "docker") {
    const info = await dockerHost({ fleet: String(run.holder.fleet), docker: str(values.docker) }).describe(run.holder).catch(() => null);
    holderStatus = info?.status ?? "unknown";
    container = info as unknown as Json;
  } else if (run?.holder) {
    holderStatus = await localHost({ hostName: str(values["host-name"]), mode: "systemd", user: process.getuid?.() === 0 ? 0 : undefined }).status(run.holder);
  }
  emit({ run: id, runJson: run as unknown as Json, delegations: delegations.map(({ clientId, inodeId, path, isOrphaned, isPending }) => ({ clientId, inodeId, path, isOrphaned, isPending })), holderStatus, ...(container ? { container } : {}) });
  return 0;
}

async function release(values: Record<string, unknown>): Promise<number> {
  need(values, "id");
  const via = await unmountClaim(join(str(values["mount-root"], DEFAULT_MOUNT_ROOT)!, runPath(str(values.id)!)));
  emit({ run: values.id, released: via });
  return 0;
}

async function forkRun(values: Record<string, unknown>): Promise<number> {
  need(values, "disk", "region", "id", "new-id");
  const disk = await control(values);
  const result = await fork({ disk: str(values.disk)!, region: str(values.region)!, id: str(values.id)! }, str(values["new-id"])!, {
    control: disk,
    mountRoot: str(values["mount-root"], DEFAULT_MOUNT_ROOT)!,
    host: { archil: str(values.archil) },
    tokenPrefix: str(values["token-prefix"]),
    onResource: (kind, id, detail) => emit({ event: "fork-resource", kind, id, detail }),
  });
  emit({ event: "forked", ...result });
  return 0;
}

const COMMON = { disk: { type: "string" }, region: { type: "string" }, id: { type: "string" }, "mount-root": { type: "string" }, "api-key-env": { type: "string" }, "host-name": { type: "string" } } as const;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "run":
        return await runInstance(
          parse(rest, {
            ...COMMON,
            archil: { type: "string" },
            app: { type: "string" },
            "heartbeat-ms": { type: "string" },
            "lease-expiry-ms": { type: "string" },
            "lease-margin-ms": { type: "string" },
            "on-sigterm": { type: "string" },
            "token-stdin": { type: "boolean" },
            serve: { type: "string" },
            "serve-host": { type: "string" },
            "serve-token-file": { type: "string" },
            "serve-url": { type: "string" },
            "park-threshold": { type: "string" },
            "park-idle": { type: "string" },
            "drain-timeout": { type: "string" },
            "run-as": { type: "string" },
          }),
        );
      case "supervise":
        return await supervise(
          parse(rest, {
            ...COMMON,
            id: { type: "string", multiple: true },
            all: { type: "boolean" },
            every: { type: "string" },
            check: { type: "boolean" },
            driver: { type: "string" },
            "unit-prefix": { type: "string" },
            user: { type: "string" },
            group: { type: "string" },
            app: { type: "string" },
            "run-arg": { type: "string", multiple: true },
            "lease-expiry": { type: "string" },
            "stonith-timeout": { type: "string" },
            "start-grace": { type: "string" },
            "start-backoff-max": { type: "string" },
            "stop-timeout": { type: "string" },
            "token-ttl": { type: "string" },
            "token-prefix": { type: "string" },
            "no-restart": { type: "boolean" },
            "log-dir": { type: "string" },
            demand: { type: "boolean" },
            create: { type: "boolean" },
            env: { type: "string", multiple: true },
            "check-id-prefix": { type: "string" },
            archil: { type: "string" },
            "control-timeout": { type: "string" },
            "sweep-tokens": { type: "boolean" },
            "token-grace": { type: "string" },
            "park-threshold": { type: "string" },
            host: { type: "string" },
            image: { type: "string" },
            docker: { type: "string" },
            fleet: { type: "string" },
            "name-prefix": { type: "string" },
            "app-root": { type: "string" },
            "run-as": { type: "string" },
            "docker-arg": { type: "string", multiple: true },
            apparmor: { type: "string" },
          }),
        );
      case "status":
        return await status(parse(rest, { ...COMMON, docker: { type: "string" } }));
      case "release":
        return await release(parse(rest, COMMON));
      case "fork":
        return await forkRun(parse(rest, { ...COMMON, "new-id": { type: "string" }, archil: { type: "string" }, "token-prefix": { type: "string" } }));
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
