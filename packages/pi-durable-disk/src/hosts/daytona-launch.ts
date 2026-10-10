// The in-box launcher for `daytonaHost`: a sandbox has no systemd (the Daytona daemon is PID 1), so this keeps the instance
// alive in place, as a systemd unit does on a host.
// It runs as root, started through the toolbox, and keeps one instance of a run alive in its box:
//   start <name>   move the spec and token from the toolbox user's staging directory (`--stage`), spawn `serve` detached (its own session, so the toolbox's process-group kill never reaches it), wait
//                  until the first incarnation is spawned, print the state
//   serve <name>   read the spec and the mount token, unlink the token file, run the instance as the run user with the
//                  token on a pipe to its stdin, restart it after a non-terminal exit (never after 0, 65, 70, 75 or 76,
//                  and not past the restart limit), forward SIGTERM to it, write `<name>.state` on every change
//   status <name>  print running, stopped or failed from the state file and whether the processes still live (a launcher
//                  whose state says exited is done, while its process exits)
//   stop <name>    SIGTERM the launcher (it drains the instance), SIGKILL both after the timeout, print the state
// Files live in a root-only directory (default /run/pda, 0700), which the run user can never traverse: `<name>.json`
// (the spec), `<name>.token` (gone once read), `<name>.state`, `<name>.log` (the instance's output). Only the first
// incarnation gets the token; a restart in place reads an empty stdin and reuses its live mount, as under localHost.
// No cgroup per incarnation: commands a crashed instance detached can outlive it until the box is deleted.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { procStartTicks, TERMINAL_EXITS } from "./local-host.ts";

export const LAUNCH_DIR = "/run/pda";
export const LAUNCH_SCRIPT = fileURLToPath(import.meta.url);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface LaunchSpec {
  /** The instance command and its arguments (absolute program path). */
  argv: string[];
  /** The instance's whole environment besides PATH, LANG and HOME (the holder handle, an app's settings). */
  env: Record<string, string>;
  /** The run user (name or uid). Required when the launcher runs as root, which never runs the instance as root. */
  user?: string;
  group?: string;
  /** Restart after a non-terminal exit (default true). */
  restart?: boolean;
  restartDelayMs?: number;
  /** More than `burst` restarts within `intervalMs` ends the launcher (systemd's start limit). Default 5 in 60 s. */
  restartLimit?: { burst: number; intervalMs: number };
  terminalExits?: number[];
}

export type LaunchPhase = "running" | "restarting" | "stopping" | "exited";

export type LaunchState = {
  launcher: number;
  launcherTicks: number | null;
  phase: LaunchPhase;
  instance: number | null;
  instanceTicks: number | null;
  /** Incarnations spawned so far; 0 means the instance never ran (refused spec, failed spawn). */
  spawned: number;
  restarts: number;
  /** The last incarnation's exit code (128 + signal number for a signal), null while one runs. */
  exit: number | null;
  signal: string | null;
  /** Why the launcher stopped restarting: terminal exit, clean exit, stopped, restart limit, spawn failure. */
  reason: string | null;
  at: string;
};

export type LaunchStatus = { status: "running" | "stopped" | "failed"; state: LaunchState | null; launcherAlive: boolean; instanceAlive: boolean };

const files = (dir: string, name: string) => {
  if (!NAME.test(name)) throw new Error(`launch name ${JSON.stringify(name)} is not one safe path segment`);
  const base = join(dir, name);
  return { spec: `${base}.json`, token: `${base}.token`, state: `${base}.state`, log: `${base}.log` };
};

export function readState(dir: string, name: string): LaunchState | null {
  const path = files(dir, name).state;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LaunchState;
  } catch {
    return null;
  }
}

function writeState(path: string, state: LaunchState): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

const alive = (pid: number | null, ticks: number | null) => pid !== null && ticks !== null && procStartTicks(pid) === ticks;

/**
 * running while the instance lives, or while the launcher lives and has not ended; otherwise stopped after a clean exit,
 * failed after any other end. A launcher that wrote "exited" spawns and restarts nothing more: only its own teardown is
 * left, which a loaded machine stretches to hundreds of ms, so its state is the answer from that write on.
 */
export function launchStatus(dir: string, name: string): LaunchStatus {
  const state = readState(dir, name);
  if (!state) return { status: "failed", state: null, launcherAlive: false, instanceAlive: false };
  const launcherAlive = alive(state.launcher, state.launcherTicks);
  const instanceAlive = alive(state.instance, state.instanceTicks);
  if (instanceAlive || (launcherAlive && state.phase !== "exited")) return { status: "running", state, launcherAlive, instanceAlive };
  const clean = state.phase === "exited" && state.exit === 0;
  return { status: clean ? "stopped" : "failed", state, launcherAlive, instanceAlive };
}

/** /etc/passwd or /etc/group field lookup: a name or a numeric id to the numeric id (and the passwd home). */
function lookup(file: "/etc/passwd" | "/etc/group", key: string): { id: number; home?: string } {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const f = line.split(":");
    if (f.length >= 3 && (f[0] === key || f[2] === key)) return { id: Number(f[2]), home: file === "/etc/passwd" ? f[5] : undefined };
  }
  throw new Error(`${key} is not in ${file}`);
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15 };

/** Who the instance runs as: the spec's user (numeric ids for spawn) or, with no user, this process. */
function runAs(spec: LaunchSpec): { uid?: number; gid?: number; home: string } {
  const isRoot = process.getuid?.() === 0;
  if (spec.user === undefined) {
    if (isRoot) throw new Error("the launcher runs as root and the spec names no run user");
    return { home: process.env.HOME ?? "/" };
  }
  const u = lookup("/etc/passwd", spec.user);
  const gid = lookup("/etc/group", spec.group ?? spec.user).id;
  if (u.id === 0) throw new Error("the instance never runs as root");
  if (isRoot) return { uid: u.id, gid, home: u.home ?? "/" };
  if (u.id !== process.getuid?.()) throw new Error("switching to the run user needs root");
  return { home: u.home ?? "/" };
}

/** The loop `serve` runs; resolves with the final state. */
export async function serve(dir: string, name: string): Promise<LaunchState> {
  const f = files(dir, name);
  const state: LaunchState = { launcher: process.pid, launcherTicks: procStartTicks(process.pid), phase: "running", instance: null, instanceTicks: null, spawned: 0, restarts: 0, exit: null, signal: null, reason: null, at: new Date().toISOString() };
  const save = (patch: Partial<LaunchState>) => writeState(f.state, Object.assign(state, patch, { at: new Date().toISOString() }));
  let spec: LaunchSpec;
  let token: string | null;
  let ids: { uid?: number; gid?: number; home: string };
  try {
    spec = JSON.parse(readFileSync(f.spec, "utf8")) as LaunchSpec;
    // No token file: a launcher started again after a crash runs its instance with an empty stdin.
    token = existsSync(f.token) ? readFileSync(f.token, "utf8").trim() : "";
    if (existsSync(f.token)) unlinkSync(f.token);
    ids = runAs(spec);
  } catch (err) {
    save({ phase: "exited", exit: 1, reason: `refused: ${(err as Error).message}` });
    return state;
  }
  const restart = spec.restart !== false;
  const delay = spec.restartDelayMs ?? 1_000;
  const limit = spec.restartLimit ?? { burst: 5, intervalMs: 60_000 };
  const terminal = spec.terminalExits ?? [...TERMINAL_EXITS];
  let stopping = false;
  let child: ReturnType<typeof spawn> | null = null;
  const onSignal = () => {
    stopping = true;
    if (state.phase === "restarting") save({ phase: "stopping" });
    else if (child?.exitCode === null) {
      save({ phase: "stopping" });
      child.kill("SIGTERM");
    }
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const log = openSync(f.log, "a", 0o600);
  const recent: number[] = [];
  try {
    for (;;) {
      const env = { PATH: SAFE_PATH, LANG: "C.UTF-8", HOME: ids.home, ...spec.env };
      const first = token !== null;
      try {
        child = spawn(spec.argv[0], spec.argv.slice(1), { uid: ids.uid, gid: ids.gid, env, cwd: "/", stdio: [first ? "pipe" : "ignore", log, log], detached: true });
        await new Promise<void>((resolve, reject) => {
          child!.once("spawn", resolve);
          child!.once("error", reject);
        });
      } catch (err) {
        save({ phase: "exited", instance: null, instanceTicks: null, exit: 1, reason: `spawn failed: ${(err as Error).message}` });
        return state;
      }
      if (first) {
        child.stdin!.on("error", () => {});
        child.stdin!.end(token ? `${token}\n` : "");
        token = null;
      }
      save({ phase: stopping ? "stopping" : "running", instance: child.pid!, instanceTicks: procStartTicks(child.pid!), spawned: state.spawned + 1, exit: null, signal: null });
      if (stopping) child.kill("SIGTERM");
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child!.once("exit", (c, s) => resolve([c, s])));
      const exit = code ?? 128 + (SIGNALS[signal ?? ""] ?? 0);
      save({ instance: null, instanceTicks: null, exit, signal });
      const now = Date.now();
      recent.push(now);
      while (recent.length && recent[0] < now - limit.intervalMs) recent.shift();
      const end =
        stopping ? "stopped"
        : exit === 0 ? "clean exit"
        : terminal.includes(exit) ? `terminal exit ${exit}`
        : !restart ? "restart disabled"
        : recent.length > limit.burst ? `restart limit (${limit.burst} in ${limit.intervalMs} ms)`
        : null;
      if (end) {
        save({ phase: "exited", reason: end });
        return state;
      }
      save({ phase: "restarting", restarts: state.restarts + 1 });
      await new Promise((r) => setTimeout(r, delay));
      if (stopping) {
        save({ phase: "exited", reason: "stopped" });
        return state;
      }
    }
  } finally {
    closeSync(log);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn `serve` in its own session and wait until its first incarnation is spawned (or the launcher ended without one). */
export async function start(dir: string, name: string, timeoutMs = 30_000, stage?: string): Promise<LaunchState | null> {
  const f = files(dir, name);
  if (readState(dir, name)) throw new Error(`${name} was already launched in this box`);
  if (stage) {
    // The toolbox's user uploaded into its own 0700 staging directory; move both files into the root-only directory.
    const from = files(stage, name);
    for (const [src, dst] of [[from.spec, f.spec], [from.token, f.token]] as const) {
      if (!existsSync(src)) continue;
      writeFileSync(dst, readFileSync(src), { mode: 0o600 });
      unlinkSync(src);
    }
  }
  if (!existsSync(f.spec)) throw new Error(`no launch spec at ${f.spec}`);
  const child = spawn(process.execPath, [LAUNCH_SCRIPT, "serve", name, "--dir", dir], { detached: true, stdio: "ignore", env: { PATH: SAFE_PATH, LANG: "C.UTF-8" } });
  child.unref();
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(25)) {
    const s = readState(dir, name);
    if (s && (s.phase === "exited" || s.spawned > 0)) return s;
  }
  return readState(dir, name);
}

/** SIGTERM the launcher (it drains the instance); past the timeout SIGKILL the instance's group and the launcher. */
export async function stop(dir: string, name: string, timeoutMs: number): Promise<LaunchStatus> {
  const kill = (pid: number | null, ticks: number | null, signal: NodeJS.Signals, group = false) => {
    if (!alive(pid, ticks)) return;
    try {
      process.kill(group ? -pid! : pid!, signal);
    } catch {
      // gone between the check and the signal
    }
  };
  let s = launchStatus(dir, name);
  if (s.status !== "running") return s;
  if (s.launcherAlive) kill(s.state!.launcher, s.state!.launcherTicks, "SIGTERM");
  else kill(s.state!.instance, s.state!.instanceTicks, "SIGTERM");
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(50)) {
    s = launchStatus(dir, name);
    if (s.status !== "running") return s;
  }
  kill(s.state!.instance, s.state!.instanceTicks, "SIGKILL", true);
  kill(s.state!.launcher, s.state!.launcherTicks, "SIGKILL");
  for (let i = 0; i < 40 && launchStatus(dir, name).status === "running"; i++) await sleep(50);
  return launchStatus(dir, name);
}

async function main(argv: string[]): Promise<number> {
  const [verb, name, ...rest] = argv;
  const opt = (flag: string) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const dir = opt("--dir") ?? LAUNCH_DIR;
  const timeoutMs = Number(opt("--timeout-ms") ?? 30_000);
  const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  switch (verb) {
    case "serve":
      await serve(dir, name);
      return 0;
    case "start": {
      const s = await start(dir, name, timeoutMs, opt("--stage"));
      print(s);
      return s && s.spawned > 0 ? 0 : 1;
    }
    case "status":
      print(launchStatus(dir, name));
      return 0;
    case "stop":
      print(await stop(dir, name, timeoutMs));
      return 0;
    default:
      process.stderr.write("usage: daytona-launch.ts start|serve|status|stop NAME [--dir DIR] [--stage DIR] [--timeout-ms MS]\n");
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === LAUNCH_SCRIPT) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
