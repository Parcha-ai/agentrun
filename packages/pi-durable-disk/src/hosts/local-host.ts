// localHost: run an instance of a run on this machine. Default mode: a systemd transient service created
// through the system manager, running as an unprivileged user with KillMode=control-group, so stopping or restarting
// it kills every command the instance started, pi's detached ones included. Development mode ("child"): a detached
// child process, without that guarantee (commands of a crashed child can outlive it).
//
// Root: every archil verb needs root (client 0.8.42), so the instance runs them through `sudo -n`, as the claim does;
// the instance and the agent's tools run as `user`. The mount goes through `bin/archil-scoped`, which starts the FUSE
// daemon in its own scope (`<unit>-fuse-<n>.scope`), outside the instance's control group: a restart in place finds
// the claim still held. The mount token is reusable for a day, so no process of the run's user may read it:
// it reaches the instance on stdin from a root-only file (/run/pi-durable-disk/<unit>.mount-token) that systemd opens
// as root; the file is replaced by an empty one once the unit started (the instance's fd keeps the token, a restart in
// place reads nothing and reuses its live mount), the instance closes its stdin after reading, and stop removes it.
// The token is never in argv, the environment, a systemd credential directory or anything the run's user can open.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIL_SCOPED, DEAD_CONNECTION, DEFAULT_MOUNT_ROOT, runPath, type RunRef } from "../claim.ts";
import { EXIT_FENCED, EXIT_HELD, PdaError } from "../errors.ts";
import { LOCAL_PARK_THRESHOLD_MS } from "../park.ts";
import type { HostDriver, HostHandle, HostStatus, Json } from "../supervise.ts";

export type Ran = { code: number | null; timedOut: boolean; stdout: string; stderr: string };
/** Runs one command; replaceable so tests can record argv without systemd. */
export type Runner = (argv: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<Ran>;

export interface LocalHostOptions {
  /** "systemd" (default) or "child" (development: no cgroup, so no guarantee about orphaned commands). */
  mode?: "systemd" | "child";
  /** Must be the same on every host of a deployment. Default /mnt/archil. */
  mountRoot?: string;
  /** The instance program; `run` and its flags are appended. Default: this Node and the package's CLI. */
  command?: string[];
  /** Extra flags for `run` (an app module, heartbeat periods). */
  runArgs?: string[];
  /** Unit names are `<unitPrefix><run id>-<stamp>`. Default "pda-". */
  unitPrefix?: string;
  /** The unprivileged user and group the instance and its tools run as. Default this process's; required as root. */
  user?: string | number;
  group?: string | number;
  /** The name this driver answers to in `holder.host`; a handle with another host is not this driver's. */
  hostName?: string;
  /** Extra environment for the instance. The driver never copies its own environment (which holds the API key). */
  env?: Record<string, string>;
  /** The archil wrapper the instance mounts through (it takes the token on stdin); default this package's `bin/archil-scoped`. */
  archil?: string;
  /**
   * TimeoutStopSec: SIGTERM, then SIGKILL of the whole control group after this. Default 30 s. The instance drains for
   * this long minus a close reserve (half of it, at most 5 s) before it releases.
   */
  stopTimeoutMs?: number;
  /**
   * The instance parks a run whose live work only waits longer than this, which must be at least twice this driver's
   * start time (about 1.5 s). Default 60 s. null: never park, the instance stays up through every wait.
   */
  parkThresholdMs?: number | null;
  /** Restart=on-failure, except after a terminal exit (`TERMINAL_EXITS`: 65, 70, 75, 76). */
  restart?: boolean;
  /** Child mode: append the instance's output to `<logDir>/<unit>.log`. */
  logDir?: string;
  sudo?: string | false;
  exec?: Runner;
  procMounts?: string;
}

export class LocalHostError extends PdaError {
  constructor(code: "INVALID_ARGUMENT" | "START_FAILED" | "STOP_FAILED", message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const TOKEN_DIR = "/run/pi-durable-disk";
const SYSTEMCTL = "/usr/bin/systemctl";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const ARCHIL = "/usr/bin/archil";
const UNIT_SAFE = /^[A-Za-z0-9:_.-]{1,200}$/;
const POLITE_UNMOUNT_MS = 10_000;
/**
 * A stat of one path in a child process, so a stuck daemon never blocks this one: prints the errno code (or "ok"), never a
 * message, which coreutils' `stat` prints in the locale's language.
 */
const STAT_CODE = `try { require("node:fs").statSync(process.argv[1]); process.stdout.write("ok"); } catch (e) { process.stdout.write(String(e.code)); process.exitCode = 1; }`;
/** The argv of that child for `path`. */
export const statCodeArgv = (path: string): string[] => [process.execPath, "-e", STAT_CODE, path];
const FUSERMOUNT = "/usr/bin/fusermount";
const UMOUNT = "/usr/bin/umount";
/** How long a stat of the mountpoint may take before its daemon counts as alive but stuck (never removed). */
const STAT_TIMEOUT_MS = 3_000;
/** EX_DATAERR: a store behind its seal or a bad run.json (run.ts names it EXIT_DATAERR). */
const EXIT_DATAERR = 65;
/** EX_SOFTWARE: the store's head is unreadable (pi's schema moved); run.json says failed, STORE_HEAD_UNREADABLE. */
const EXIT_SOFTWARE = 70;
/** Exits a restart cannot fix: 65 data error, 70 store head unreadable, 75 fenced, 76 held. */
export const TERMINAL_EXITS = [EXIT_DATAERR, EXIT_SOFTWARE, EXIT_FENCED, EXIT_HELD] as const;

// The package's own CLI, with the extension this module has: `.ts` from a checkout, `.js` once built.
const CLI = fileURLToPath(new URL(`../cli${extname(import.meta.url)}`, import.meta.url));

/** Minimal environment, a timeout that settles even if a grandchild keeps the pipes, and the input on stdin. */
export const runCommand: Runner = (argv, opts = {}) =>
  new Promise((resolve, reject) => {
    let stdout = "", stderr = "", settled = false;
    const child = spawn(argv[0], argv.slice(1), { env: { PATH: SAFE_PATH, LANG: "C.UTF-8", HOME: process.env.HOME ?? "/" }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    const done = (r: Ran) => void (settled || ((settled = true), clearTimeout(timer), resolve(r)));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
      done({ code: null, timedOut: true, stdout, stderr });
    }, opts.timeoutMs ?? 30_000);
    child.on("error", (err) => void (settled || ((settled = true), clearTimeout(timer), reject(err))));
    child.on("close", (code) => done({ code, timedOut: false, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });

export function currentBootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

const firstLine = (r: Ran) => (r.stderr.trim().split("\n").at(-1) ?? "").slice(0, 300);
const okRan = (r: Ran) => r.code === 0 && !r.timedOut;

/** `systemctl show` output as a map. */
export function parseShow(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** A unit's state as a host status: loaded and active (or restarting) is running; unloaded is gone. */
export function unitStatus(show: Record<string, string>): HostStatus {
  if (show.LoadState === "not-found" || show.LoadState === undefined) return "gone";
  switch (show.ActiveState) {
    case "active":
    case "activating":
    case "deactivating":
    case "reloading":
    case "refreshing":
      return "running";
    case "failed":
      return "failed";
    case "inactive":
      return "stopped";
    default:
      return "unknown";
  }
}

export function localHost(opts: LocalHostOptions = {}): HostDriver & { readonly hostName: string; readonly mountRoot: string } {
  const mode = opts.mode ?? "systemd";
  const mountRoot = opts.mountRoot ?? DEFAULT_MOUNT_ROOT;
  const hostName = opts.hostName ?? hostname();
  const bootId = currentBootId();
  const exec = opts.exec ?? runCommand;
  const isRoot = process.getuid?.() === 0;
  const sudo = opts.sudo ?? (isRoot ? false : "/usr/bin/sudo");
  const asRoot = (argv: string[]) => (sudo ? [sudo, "-n", ...argv] : argv);
  const root = (argv: string[], o?: { input?: string; timeoutMs?: number }) => exec(asRoot(argv), o);
  if (isRoot && opts.user === undefined && mode === "systemd") {
    throw new LocalHostError("INVALID_ARGUMENT", "running as root: name the unprivileged user the instance runs as (user)");
  }
  const user = String(opts.user ?? process.getuid?.() ?? "");
  const group = String(opts.group ?? process.getgid?.() ?? "");
  const command = opts.command ?? [process.execPath, CLI];
  const archil = opts.archil ?? ARCHIL_SCOPED;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 30_000;
  const prefix = opts.unitPrefix ?? "pda-";
  const procMounts = opts.procMounts ?? "/proc/self/mounts";

  const mine = (h: HostHandle) => h.driver === "local" && h.host === hostName;
  const mountpointOf = (ref: RunRef) => join(mountRoot, runPath(ref.id));
  const mounted = async (mp: string) => (await readFile(procMounts, "utf8")).split("\n").some((l) => l.split(" ")[1] === mp);

  const parkMs = opts.parkThresholdMs === undefined ? LOCAL_PARK_THRESHOLD_MS : opts.parkThresholdMs;
  const drainMs = Math.max(0, stopTimeoutMs - Math.min(5_000, stopTimeoutMs / 2));
  const runFlags = (ref: RunRef) => [
    "run", "--disk", ref.disk, "--region", ref.region, "--id", ref.id, "--mount-root", mountRoot, "--archil", archil,
    ...(parkMs ? ["--park-threshold", `${parkMs}ms`] : []),
    "--drain-timeout", `${Math.floor(drainMs)}ms`,
    ...(opts.runArgs ?? []),
  ];
  const holderEnv = (h: Record<string, Json>) => JSON.stringify(h);

  const tokenFile = (unit: string) => join(TOKEN_DIR, `${unit}.mount-token`);

  async function writeTokenFile(path: string, token: string): Promise<void> {
    if (!sudo) {
      await mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
      await writeFile(path, token, { mode: 0o600 });
      return;
    }
    const r = await root(["/bin/sh", "-c", 'umask 077 && mkdir -p "$1" && cat > "$2"', "sh", TOKEN_DIR, path], { input: token });
    if (!okRan(r)) throw new LocalHostError("START_FAILED", `cannot write the mount token file: ${firstLine(r)}`);
  }

  /** Replace the token file by an empty one: the started instance's open fd keeps the token, the path no longer has it. */
  async function emptyTokenFile(path: string): Promise<void> {
    const r = await root(["/bin/sh", "-c", 'umask 077 && : > "$1.tmp" && mv -f "$1.tmp" "$1"', "sh", path]);
    if (!okRan(r)) await removeFile(path);
  }

  async function removeFile(path: string): Promise<void> {
    if (!sudo) return rm(path, { force: true });
    await root(["/bin/rm", "-f", path]);
  }

  async function startUnit(ref: RunRef, token: string): Promise<HostHandle> {
    const unit = `${prefix}${ref.id}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
    if (!UNIT_SAFE.test(unit)) throw new LocalHostError("INVALID_ARGUMENT", `unit name ${unit} is not safe`);
    const mountpoint = mountpointOf(ref);
    const handle: HostHandle = { driver: "local", mode: "systemd", host: hostName, bootId, unit, mountpoint };
    const env: Record<string, string> = { ...opts.env, PATH: SAFE_PATH, PDA_HOLDER: holderEnv(handle) };
    const path = tokenFile(unit);
    await writeTokenFile(path, token);
    let started = false;
    try {
      const argv = [
        SYSTEMD_RUN,
        `--unit=${unit}`,
        `--description=pi-durable-disk run ${ref.id}`,
        "--service-type=exec",
        "--quiet",
        "-p", "KillMode=control-group",
        "-p", `TimeoutStopSec=${Math.max(1, Math.ceil(stopTimeoutMs / 1000))}s`,
        ...(opts.restart === false ? [] : ["-p", "Restart=on-failure", "-p", "RestartSec=1", "-p", `RestartPreventExitStatus=${TERMINAL_EXITS.join(" ")}`]),
        "-p", `User=${user}`,
        "-p", `Group=${group}`,
        "-p", `StandardInput=file:${path}`,
        ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`),
        "--",
        ...command,
        ...runFlags(ref),
        "--token-stdin",
      ];
      const r = await root(argv, { timeoutMs: 60_000 });
      if (!okRan(r)) throw new LocalHostError("START_FAILED", `systemd-run ${unit}: ${r.timedOut ? "timed out" : `exit ${r.code}`}: ${firstLine(r)}`);
      started = true;
      return handle;
    } finally {
      // Type=exec: systemd-run returns after the exec, so the instance's stdin is already open on the token. The path
      // stays (empty) because a restart in place opens it again; stop removes it.
      await (started ? emptyTokenFile(path) : removeFile(path)).catch(() => {});
    }
  }

  async function startChild(ref: RunRef, token: string): Promise<HostHandle> {
    const tag = `${prefix}${ref.id}-${Date.now().toString(36)}`;
    const mountpoint = mountpointOf(ref);
    const base: HostHandle = { driver: "local", mode: "child", host: hostName, bootId, mountpoint, tag };
    let out: "ignore" | number = "ignore";
    if (opts.logDir) {
      const { openSync } = await import("node:fs");
      out = openSync(join(opts.logDir, `${tag}.log`), "a", 0o600);
    }
    const env = { ...opts.env, PATH: SAFE_PATH, LANG: "C.UTF-8", HOME: process.env.HOME ?? "/", PDA_HOLDER: holderEnv(base) };
    const child = spawn(command[0], [...command.slice(1), ...runFlags(ref), "--token-stdin"], { detached: true, stdio: ["pipe", out, out], env });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (err) => reject(new LocalHostError("START_FAILED", `cannot start ${command[0]}`, { cause: err })));
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(`${token}\n`);
    child.unref();
    if (typeof out === "number") (await import("node:fs")).closeSync(out);
    const pid = child.pid!;
    return { ...base, pid, startTicks: procStartTicks(pid) ?? 0 };
  }

  /** The FUSE scopes this unit's mounts run in that are still active. */
  async function fuseScopes(unit: string): Promise<string[]> {
    const r = await exec([SYSTEMCTL, "list-units", "--all", "--plain", "--no-legend", "--type=scope", `${unit}-fuse-*`]);
    return r.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f.length >= 3 && f[2] === "active")
      .map((f) => f[0]);
  }

  /** SIGKILL the unit's FUSE daemons (power-off semantics for its mount) and wait until their scopes are gone. */
  async function killDaemons(unit: string): Promise<void> {
    const alive = await fuseScopes(unit);
    if (!alive.length) return;
    await root([SYSTEMCTL, "kill", "--signal=SIGKILL", ...alive]);
    for (let i = 0; i < 50 && (await fuseScopes(unit)).length; i++) await new Promise((r) => setTimeout(r, 100));
  }

  /**
   * Whether the mount at `mp` is dead: its FUSE daemon is gone, so the stat fails with one of `DEAD_CONNECTION`'s codes
   * (ENOTCONN, or ECONNABORTED for a stat in flight while the dying daemon's connection is torn down). The stat runs in a
   * child with a timeout, so a live but stuck daemon never blocks this process, and the child prints the code, not a
   * message; a stat that answers, fails otherwise or does not finish is a live mount.
   */
  async function deadMount(mp: string): Promise<boolean> {
    const r = await exec(statCodeArgv(mp), { timeoutMs: STAT_TIMEOUT_MS });
    return !r.timedOut && r.code !== 0 && DEAD_CONNECTION.has(r.stdout.trim());
  }

  /** Remove a dead mount: `fusermount -u`, then a lazy `umount -l`. The mount table, not an exit code, decides. */
  async function removeDeadMount(mp: string): Promise<void> {
    await root([FUSERMOUNT, "-u", mp]);
    if (await mounted(mp)) await root([UMOUNT, "-l", mp]);
    if (await mounted(mp)) throw new LocalHostError("STOP_FAILED", `${mp} is still mounted after fusermount -u and umount -l`);
    await root(["/bin/rmdir", mp]);
  }

  /**
   * Clean the run's mount after its instance is gone. With the mount in the table and this unit's FUSE scope alive:
   * `archil unmount` (flush, check the delegation in) in a child process with a short timeout. Then this unit's FUSE
   * scope is SIGKILLed while it is still active, whatever the mount table says: a client whose filesystem FAILED (an
   * auth failure at a token refresh) drops its mount but keeps its process and the mountpoint's control socket, and the
   * next mount at the path is refused for as long as it lives. The scope must be gone afterwards. Then a mount still in
   * the table whose daemon is gone (a power off, an OOM kill, the SIGKILL) is removed. A live mount without this unit's
   * scope is a newer instance's and is never touched; nothing here stats the mount from this process.
   */
  async function cleanMount(unit: string, mp: string): Promise<void> {
    if ((await mounted(mp)) && (await fuseScopes(unit)).length) await root([ARCHIL, "unmount", mp], { timeoutMs: POLITE_UNMOUNT_MS });
    await killDaemons(unit);
    const left = await fuseScopes(unit);
    if (left.length) throw new LocalHostError("STOP_FAILED", `${left.join(", ")} still active after SIGKILL`);
    if ((await mounted(mp)) && (await deadMount(mp))) await removeDeadMount(mp);
  }

  async function show(unit: string): Promise<Record<string, string>> {
    const r = await exec([SYSTEMCTL, "show", `${unit}.service`, "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,MainPID"]);
    return parseShow(r.stdout);
  }

  return {
    hostName,
    mountRoot,
    start(ref, token) {
      runPath(ref.id);
      return mode === "systemd" ? startUnit(ref, token) : startChild(ref, token);
    },

    async status(h) {
      if (!mine(h)) return "unknown";
      if (h.bootId !== bootId) return "gone";
      if (h.mode === "child") {
        const ticks = procStartTicks(Number(h.pid));
        return ticks === null || ticks !== h.startTicks ? "stopped" : "running";
      }
      if (typeof h.unit !== "string" || !UNIT_SAFE.test(h.unit)) return "unknown";
      return unitStatus(await show(h.unit));
    },

    async stop(h) {
      if (!mine(h) || h.bootId !== bootId) return;
      if (h.mode === "child") {
        const pid = Number(h.pid);
        const alive = () => procStartTicks(pid) === h.startTicks;
        if (!alive()) return;
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          return;
        }
        for (let t = 0; t < stopTimeoutMs && alive(); t += 100) await new Promise((r) => setTimeout(r, 100));
        if (alive()) process.kill(-pid, "SIGKILL");
        return;
      }
      if (typeof h.unit !== "string" || !UNIT_SAFE.test(h.unit)) return;
      const stopUnit = () => root([SYSTEMCTL, "stop", `${h.unit}.service`], { timeoutMs: stopTimeoutMs + 10_000 });
      let r = await stopUnit();
      if (!okRan(r) && unitStatus(await show(h.unit)) === "running") {
        // A unit that outlives SIGKILL is wedged in its mount (a FUSE request its daemon never answers): kill the
        // daemon so those requests fail and the processes can die, then stop once more.
        await killDaemons(h.unit);
        r = await stopUnit();
        if (!okRan(r) && unitStatus(await show(h.unit)) === "running") {
          throw new LocalHostError("STOP_FAILED", `systemctl stop ${h.unit}: ${r.timedOut ? "timed out" : firstLine(r)}`);
        }
      }
      await cleanMount(h.unit, String(h.mountpoint));
      await root([SYSTEMCTL, "reset-failed", `${h.unit}.service`]);
      await removeFile(tokenFile(h.unit));
    },
  };
}

/** Field 22 of /proc/<pid>/stat (start time in clock ticks), so a reused pid is never mistaken for the instance. */
export function procStartTicks(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (rest[0] === "Z" || rest[0] === "X") return null;
  return Number(rest[19]);
}
