// The local session machine every harness adapter runs its harness on, written for AgentRun: where a session's harness
// runs when the host runs it on its own box. One implementation for every harness; each adapter names only what is its
// own (its private directories, its provider policy, how it reads its child's output):
//  - the session gets private directories under its own directory (mode 0700), and an empty working directory (`work`);
//  - a child's environment is an allowlist: PATH, LANG and TZ from this process, plus what the harness names (its homes,
//    and the per-session proxy key). Nothing else is inherited, so no provider key, token or host secret reaches it;
//  - a child's git stops at the session's directory (GIT_CEILING_DIRECTORIES), and the host may start every child under
//    its own confinement, in front of the command;
//  - each child runs in its own process group, which kill() and close() end whole;
//  - the model proxy (./proxy.ts, with the harness's policy) starts with the machine and stops with it.
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { FileTail } from "../process/tail.js";
import { startModelProxy, type ModelProxyOptions } from "./proxy.js";

/** The variables a child takes from this process, when they are set. */
export const INHERITED_ENV = Object.freeze(["PATH", "LANG", "TZ"] as const);
const STDERR_TAIL = 8 * 1024;

export type KillSignal = "SIGTERM" | "SIGKILL" | "SIGINT";

/** What a session starts on its machine. */
export interface MachineSpawn {
  command: string;
  args?: string[];
  /** The child's environment beyond the machine's allowlist (PATH, LANG, TZ). Nothing else is inherited. */
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  isolatedCommands?: boolean;
}

/** A file a harness writes into one of the machine's private directories. */
export interface CacheFile {
  path: string;
  bytes: Uint8Array;
  mode?: number;
}

/** A line-complete tail of a file in one of the machine's directories. */
export interface MachineTail {
  readonly offset: number;
  read(): string[];
  sync(): Promise<void>;
  close(): void;
}

/** A command and its arguments, as the machine starts it. */
export interface ChildCommand {
  command: string;
  args: string[];
}

/** The host's confinement of a child: the same command and arguments, started under the host's own (a
 *  `setpriv --no-new-privs` prefix, say). It may only add in front: what it returns must end with the command and its
 *  arguments unchanged, and it never sees or changes the child's environment. */
export type ConfineChild = (child: Readonly<ChildCommand>) => ChildCommand;

/** A machine's child: started detached (its own process group), with the allowlisted environment. */
export interface MachineChild {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  stderrTail(): string;
  alive(): boolean;
  kill(signal?: KillSignal): void;
}

/** The command `confine` makes of `child`, refused unless it ends with the child's command and arguments unchanged.
 *  `name` is the adapter's package name, which its messages begin with. */
export function confined(child: ChildCommand, confine: ConfineChild | undefined, name = "agentrun-kernel"): ChildCommand {
  if (!confine) return child;
  const out = confine({ command: child.command, args: [...child.args] });
  const argv = [out?.command, ...(Array.isArray(out?.args) ? out.args : [])];
  const tail = argv.slice(argv.length - child.args.length - 1);
  const kept = argv.length > child.args.length + 1 && tail.length === child.args.length + 1 && tail.every((a, i) => a === (i === 0 ? child.command : child.args[i - 1]));
  if (typeof out?.command !== "string" || !argv.every((a) => typeof a === "string") || !kept) throw new Error(`${name}: the host's confinement must start the child's own command and arguments, after its own`);
  return { command: out.command, args: out.args };
}

/** The child's environment: the allowlist from `from`, then what the caller names. */
export function childEnv(from: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = from[name];
    if (typeof value === "string") env[name] = value;
  }
  return { ...env, ...extra };
}

/** Start a child of the session: `env` beyond the allowlist, in its own process group, killed whole. Its git stops at
 *  `ceiling` (the session's directory): it never looks for a repository above the session, in a parent the model
 *  could write, whose branch and remote would otherwise reach the records. */
export function startChild(options: MachineSpawn, from: Readonly<Record<string, string | undefined>>, cwd: string, ceiling?: string, confine?: ConfineChild, name?: string): MachineChild {
  const run = confined({ command: options.command, args: options.args ?? [] }, confine, name);
  const child = spawnChild(run.command, run.args, {
    cwd: options.cwd ?? cwd,
    env: { ...childEnv(from, options.env), ...(ceiling ? { GIT_CEILING_DIRECTORIES: ceiling } : {}) },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  child.stdin!.on("error", () => {});
  let done = false;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("error", (err) => {
      stderr = (stderr + `\n${String(err.message)}`).slice(-STDERR_TAIL);
      done = true;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      done = true;
      resolve({ code, signal });
    });
  });
  const kill = (signal: KillSignal = "SIGTERM") => {
    if (done || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* gone */ }
    }
  };
  if (options.signal) {
    if (options.signal.aborted) kill("SIGKILL");
    else options.signal.addEventListener("abort", () => kill("SIGKILL"), { once: true });
  }
  return { child, exited, stderrTail: () => stderr, alive: () => !done, kill };
}

/** A path inside `base`, from a relative one; anything that would leave it throws. */
function inside(base: string, rel: string, name: string): string {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || rel.includes("\0")) throw new Error(`${name}: ${JSON.stringify(String(rel).slice(0, 80))} is not a relative path`);
  const path = normalize(join(base, rel));
  if (!path.startsWith(base + sep)) throw new Error(`${name}: ${JSON.stringify(rel.slice(0, 80))} leaves the session's directory`);
  return path;
}

export interface LocalMachineSpec<D extends string> {
  /** The adapter's package name, which the machine's messages begin with. */
  name: string;
  /** The session's own directory. The machine makes its private directories in it, and deletes only those. */
  dir: string;
  /** The private directories, made under `dir` (mode 0700). */
  dirs: readonly D[];
  /** The session's id, as the drive names it. */
  sessionId: string;
  /** Start every child of the session under the host's confinement. */
  confine?: ConfineChild;
  /** The process environment the allowlist reads. */
  from: Readonly<Record<string, string | undefined>>;
  /** The model proxy's options, its policy included; the machine makes the session's key. */
  proxy: ModelProxyOptions;
}

/** A local session machine: private directories, a loopback model proxy, and children ended with it. Unbranded: each
 *  adapter brands the machine it hands its harness. */
export interface LocalMachine<D extends string> {
  readonly sessionId: string;
  readonly root: string;
  readonly dirs: Readonly<Record<D, string>>;
  readonly signal: AbortSignal;
  /** The model proxy's base URL (loopback), and the per-session key it admits. */
  readonly modelUrl: string;
  readonly modelKey: string;
  readonly notes: readonly string[];
  /** The environment the allowlist reads. */
  readonly from: Readonly<Record<string, string | undefined>>;
  /** Start a child of the session, ended with it. */
  start(options: MachineSpawn): MachineChild;
  readonly files: {
    upload(dir: D, files: readonly CacheFile[]): Promise<void>;
    wipe(): Promise<void>;
  };
  tail(dir: D, path: string, options?: { offset?: number }): Promise<MachineTail>;
  fsync(): Promise<void>;
  close(): Promise<void>;
}

/** Make a session's local machine under `spec.dir`: the directories fresh, the proxy started. */
export async function openLocalMachine<D extends string>(spec: LocalMachineSpec<D>): Promise<LocalMachine<D>> {
  const { name, from } = spec;
  const base = normalize(spec.dir);
  if (!isAbsolute(base)) throw new Error(`${name}: the session directory must be an absolute path`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dirs = Object.fromEntries(spec.dirs.map((d) => [d, join(base, d)])) as Record<D, string>;
  const root = join(base, "work");
  for (const dir of [...Object.values<string>(dirs), root]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const key = randomBytes(32).toString("base64url");
  const proxy = await startModelProxy(spec.proxy, key);
  const lost = new AbortController();
  const children = new Set<MachineChild>();
  let closed = false;
  const start = (options: MachineSpawn): MachineChild => {
    if (closed) throw new Error(`${name}: the session machine is closed`);
    const proc = startChild(options, from, root, base, spec.confine, name);
    children.add(proc);
    void proc.exited.then(() => children.delete(proc));
    return proc;
  };

  return {
    sessionId: spec.sessionId,
    root,
    dirs,
    signal: lost.signal,
    modelUrl: proxy.url,
    modelKey: key,
    notes: [],
    from,
    start,
    files: {
      upload: async (dir, files) => {
        for (const file of files) {
          const path = inside(dirs[dir], file.path, name);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          writeFileSync(path, file.bytes, { mode: file.mode ?? 0o600 });
        }
      },
      wipe: async () => {
        for (const dir of Object.values<string>(dirs)) {
          rmSync(dir, { recursive: true, force: true });
          mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
      },
    },
    tail: async (dir, path, options = {}) => {
      const file = inside(dirs[dir], path, name);
      const tail = new FileTail(file, options.offset ?? 0);
      return {
        get offset() { return tail.offset; },
        read: () => {
          // Only the file the harness wrote: a link put in its place is not followed.
          try {
            if (lstatSync(file).isSymbolicLink()) throw new Error(`${name}: ${path} is a link`);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
          return tail.read();
        },
        // A local file is read to its end on every read.
        sync: async () => {},
        close: () => {},
      };
    },
    // A local session writes no files of its own to flush.
    fsync: async () => {},
    close: async () => {
      if (closed) return;
      closed = true;
      for (const proc of children) proc.kill("SIGKILL");
      await Promise.all([...children].map((p) => p.exited));
      lost.abort();
      await proxy.close();
    },
  };
}
