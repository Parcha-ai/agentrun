// The local session machine every harness adapter runs its harness on, written for AgentRun: where a session's harness
// runs when the host runs it on its own box. One implementation for every harness; each adapter names only what is its
// own (its private directories, its provider policy, how it reads its child's output):
//  - the session gets private directories under its own directory (mode 0700), and an empty working directory (`work`);
//  - a child's environment is an allowlist: PATH, LANG and TZ from this process, plus what the harness names (its homes,
//    and the per-session proxy key). Nothing else is inherited, so no provider key, token or host secret reaches it;
//  - a child's git stops at the session's directory (GIT_CEILING_DIRECTORIES), and the host may start every child under
//    its own confinement, in front of the command;
//  - each child runs in its own process group, which kill() and close() end whole;
//  - the model proxy (./proxy.ts, with the harness's policy) starts with the machine and stops with it;
//  - where the host gives it a box (./box.ts), every child starts in one, one at a time, through the session's slot
//    (./box-slot.ts): a box is reaped as soon as its child exits, and only the reap's own count lets the next one start.
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { FileTail } from "../process/tail.js";
import { BoxError, type Box, type BoxedChild, type BoxRecord, type BoxRecorder, type BoxSpec, type Isolation, type Reaped } from "./box.js";
import { BOX_FORWARD, BOX_LOOPBACK, forwardChild } from "./box-forward.js";
import { boxSlot } from "./box-slot.js";
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
  /** Directories of the session's own this child reads and writes beyond the machine's: in a box, bound read-write at
   *  their own paths into this child's box alone (homes `bind:0`, `bind:1`, ...), so the next child's box holds none of
   *  them. Each is checked before anything starts, in every mode, by its real path: absolute and normalized, a directory
   *  of this user's own (never a link), under the session, and never the session or one holding its directories. */
  binds?: readonly string[];
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

/** Where the box finds the host's sockets: the paths the host's box binds them at. */
export const BOX_MODEL_SOCKET = "/run/agentrun/model.sock";
export const BOX_EGRESS_SOCKET = "/run/agentrun/egress.sock";

/** Filesystems the socket directory may not be on (statfs's f_type, Linux's magic.h): FUSE, and those shared between
 *  hosts. On them a socket cannot be made, or another host's live one reads as dead here and is taken over. A backstop
 *  only: the list names what is known, and the guarantee is that the directory is meant to be local (the OS's temp
 *  directory, which TMPDIR can point anywhere, is exactly why it is checked). Linux only: elsewhere statfs's type is not
 *  these numbers, and placement is the rule. */
const NOT_LOCAL: Readonly<Record<number, string>> = {
  0x65735546: "fuse", 0x6969: "nfs", 0xff534d42: "cifs", 0xfe534d42: "smb2", 0x517b: "smb", 0x01021997: "9p", 0x00c36400: "ceph",
};

/** The session's socket directory: made 0700 if missing, and refused unless it is a directory of this process's user,
 *  0700, not a link, and on a local filesystem, so nothing else can put a socket where the box's front is looked for.
 *  `statfs` is this module's test seam, never a host's option. */
export function socketDir(dir: string, name: string, statfs: (dir: string) => { type: number } = statfsSync): string {
  // The egress proxy binds a temporary name (25 bytes) in the directory before it links its socket, and a socket's path
  // holds 107 bytes: a directory longer than 81 bytes would let the model front start and the egress proxy fail. Checked
  // on the name alone, before anything is made.
  const bytes = Buffer.byteLength(dir);
  if (bytes > 81) throw new Error(`${name}: runtime_dir_too_long: the session's socket directory ${dir} is ${bytes} bytes; a socket path in it must fit 107`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`${name}: the session's socket directory ${dir} must be this user's own, 0700, and not a link`);
  }
  const kind = process.platform === "linux" ? NOT_LOCAL[statfs(dir).type] : undefined;
  if (kind) throw new Error(`${name}: runtime_dir_not_local: the session's socket directory ${dir} is on ${kind}, not a local filesystem`);
  return dir;
}

/** A box's way out, for the clients in it that ask for a proxy: the session's egress proxy, at the port the box serves it
 *  on. The model's own port is left out (NO_PROXY), so the harness reaches its front directly. */
function proxyEnv(port: number): Record<string, string> {
  const http = `http://${BOX_LOOPBACK}:${port}`;
  const socks = `socks5h://${BOX_LOOPBACK}:${port}`;
  return {
    HTTPS_PROXY: http, https_proxy: http, HTTP_PROXY: http, http_proxy: http, ALL_PROXY: socks, all_proxy: socks,
    NO_PROXY: `${BOX_LOOPBACK},localhost`, no_proxy: `${BOX_LOOPBACK},localhost`, NODE_USE_ENV_PROXY: "1", // key-gate: loopback-rule loopback names inside the box
  };
}

/** The host's box for a session's children, and where it records them. */
export interface MachineBox {
  box: Box;
  /** Where the host keeps the session's box record, durably. */
  recorder: BoxRecorder;
  /** Bound read-only beyond the box's own system allowlist: node and the harness's pinned binary. */
  readOnly: readonly string[];
  /** The port the box serves the session's model front on, at its own loopback. The front listens on a socket of its
   *  own, in the session's directory, and nowhere else. */
  modelPort: number;
  /** The session's egress: the host's proxy (an egress proxy started on the socket path it is given, one per session),
   *  and the port the box serves it on. Absent: the box reaches nothing but the model. */
  egress?: { port: number; start(socketPath: string): Promise<{ close(): Promise<void> }> };
  /** A shared server's cgroup for the run. */
  cgroup?: string;
  /** A local directory for the session's sockets: never on a disk shared between hosts or a FUSE mount, where a socket
   *  either cannot be made or reads as dead while another host's is live. Default: one per session under the OS's temp
   *  directory, named by the session's directory and kept short (`arb-` and 12 hex digits, 17 bytes), so a long temp
   *  directory (macOS's is about 49 bytes) still leaves the socket directory under its 81-byte bound. */
  runtimeDir?: string;
}

/** The session's last box, as the host recorded it: its record, and how the host's box reaps a box by its record. The
 *  machine reaps it at every open, whatever this open's mode, before anything of the session starts. */
export interface PreviousBox {
  record: BoxRecord;
  reap(record: BoxRecord): Promise<Reaped>;
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
  /** The host's box for every child of the session, or `unsandboxed` where the operator said there is none. Absent:
   *  the host gave none, and the machine's `isolation` says so. */
  box?: MachineBox | "unsandboxed";
  /** The record the session's last box left (a relaunch, a woken run), and the reap of the box that wrote it: reaped,
   *  and counted empty, before anything of this session starts, whatever this open's mode. A session boxed before and
   *  unsandboxed now (or whose box is unavailable now) must not start beside a box of its own that still runs. */
  previousBox?: PreviousBox;
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
  /** What the host's box proved (undefined: the host gave none). A harness turns its own tools on only in a box, or
   *  where it is `unsandboxed` by the operator's word. */
  readonly isolation?: Isolation;
  /** Start a child of the session, ended with it. In a box, refused (BoxError box_busy) while the last one is live or
   *  not yet counted empty. */
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

  // A box the probe found unavailable boxes nothing: children start as they would without one, and a harness keeps its
  // own tools off, since `isolation` says why.
  const boxed = typeof spec.box === "object" ? spec.box : undefined;
  const isolation: Isolation | undefined = boxed ? boxed.box.isolation : spec.box === "unsandboxed" ? { mode: "unsandboxed" } : undefined;
  const boxing = boxed && isolation?.mode !== "unavailable" ? boxed : undefined;
  const slot = boxing ? boxSlot<BoxedChild>({ reap: (record) => boxing.box.reap(record) }) : undefined;
  // The last box first, in every mode (boxed, unsandboxed, unavailable or none): nothing of this session starts while
  // one of its old boxes may still hold a process. Only the reap's own count says it is empty; anything else fails the
  // open, by name, and the next open reaps it again.
  const previous = spec.previousBox;
  if (previous) {
    const verdict = await previous.reap(previous.record);
    if (!verdict.empty) throw new BoxError("box_not_empty", `box_not_empty: the session's last box still holds ${verdict.left} process${verdict.left === 1 ? "" : "es"} (counted by ${verdict.by}); nothing of the session starts`, { record: previous.record, left: verdict.left });
  }

  const key = randomBytes(32).toString("base64url");
  // In a box, the front's only door is a socket of the session's own, which the box is given; outside one, loopback.
  const sockets = boxing ? socketDir(boxing.runtimeDir ?? join(tmpdir(), `arb-${createHash("sha256").update(base).digest("hex").slice(0, 12)}`), name) : "";
  const modelSocket = join(sockets, "model.sock");
  const egressSocket = join(sockets, "egress.sock");
  // A failed open returns no machine to close: what it started is closed here, and the socket directory it made goes when
  // nothing is left in it (anything there is not this open's).
  const unmade = () => {
    if (boxing) try { rmdirSync(sockets); } catch { /* not empty, or gone */ }
  };
  let proxy: Awaited<ReturnType<typeof startModelProxy>>;
  try {
    proxy = await startModelProxy(boxing ? { ...spec.proxy, socketPath: modelSocket } : spec.proxy, key);
  } catch (error) {
    unmade();
    throw error;
  }
  // One egress proxy per session: its boxes, one at a time, share it and its caps; another session has its own.
  let egress: { close(): Promise<void> } | undefined;
  if (boxing?.egress) {
    try {
      egress = await boxing.egress.start(egressSocket);
    } catch (error) {
      await proxy.close();
      unmade();
      throw error;
    }
  }
  const lost = new AbortController();
  const children = new Set<MachineChild>();
  const reaps = new Set<Promise<void>>();
  let closed = false;
  // A child's binds, checked before anything starts, in every mode: the paths it may bind, as given.
  const ownDirs = [root, ...Object.values(dirs) as string[]].map((path) => realpathSync(path));
  const session = realpathSync(base);
  const holds = (outer: string, inner: string) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
  const bindsOf = (options: MachineSpawn): readonly string[] => {
    const refuse = (path: string, why: string): never => {
      throw new BoxError("box_refused", `${name}: a child's bind ${path} ${why}`);
    };
    for (const path of options.binds ?? []) {
      if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) refuse(String(path), "is not an absolute, normalized path");
      let real: string;
      try {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("not this user's own directory");
        real = realpathSync(path);
      } catch {
        refuse(path, "is not a directory of this user's own (a link, or not there)");
      }
      if (!holds(session, real!)) refuse(path, `is not under the session ${base}`);
      if (real! === session || ownDirs.some((own) => holds(real!, own))) refuse(path, "is the session or holds one of its directories");
    }
    return options.binds ?? [];
  };

  const inBox = (options: MachineSpawn, box: MachineBox): MachineChild => {
    // The box's working directory is the session's: a child that asks for another is refused, not moved.
    if (options.cwd !== undefined && normalize(options.cwd) !== root) throw new Error(`${name}: a child in a box runs in the session's working directory, not ${options.cwd}`);
    const harness = confined({ command: options.command, args: options.args ?? [] }, spec.confine, name);
    // The box's first command serves its sockets on its own loopback, then runs the harness (./box-forward.ts).
    const child: ChildCommand = forwardChild(harness, [{ port: box.modelPort, socket: BOX_MODEL_SOCKET }, ...(box.egress ? [{ port: box.egress.port, socket: BOX_EGRESS_SOCKET }] : [])]);
    const boxSpec: BoxSpec = {
      session: base,
      workspace: root,
      homes: { ...dirs, ...Object.fromEntries(bindsOf(options).map((path, i) => [`bind:${i}`, path])) },
      readOnly: [...box.readOnly, process.execPath, BOX_FORWARD],
      modelSocket,
      modelPort: box.modelPort,
      ...(box.egress ? { egressSocket, egressPort: box.egress.port } : {}),
      env: { ...childEnv(from, options.env), GIT_CEILING_DIRECTORIES: base, ...(box.egress ? proxyEnv(box.egress.port) : {}) },
      ...(box.cgroup === undefined ? {} : { cgroup: box.cgroup }),
    };
    const { process: proc, reaped } = slot!.start((recorder) => box.box.start(boxSpec, child, recorder), box.recorder);
    reaps.add(reaped);
    if (options.signal) {
      if (options.signal.aborted) proc.kill();
      else options.signal.addEventListener("abort", () => proc.kill(), { once: true });
    }
    return proc;
  };
  const start = (options: MachineSpawn): MachineChild => {
    if (closed) throw new Error(`${name}: the session machine is closed`);
    const proc = boxing ? inBox(options, boxing) : (bindsOf(options), startChild(options, from, root, base, spec.confine, name));
    children.add(proc);
    void proc.exited.then(() => children.delete(proc));
    return proc;
  };

  return {
    sessionId: spec.sessionId,
    root,
    dirs,
    signal: lost.signal,
    // The harness's view: in a box, the front at the port the box serves it on.
    modelUrl: boxing ? `http://${BOX_LOOPBACK}:${boxing.modelPort}` : proxy.url,
    modelKey: key,
    notes: [],
    from,
    ...(isolation ? { isolation } : {}),
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
      // Closed means counted empty: every box's reap gave its verdict, and one that found a process left fails the close.
      const verdicts = await Promise.allSettled(reaps);
      lost.abort();
      try {
        await egress?.close();
      } finally {
        await proxy.close();
        // The session's socket directory, once its sockets are gone; a directory holding anything else stays.
        if (boxing) try { rmdirSync(sockets); } catch { /* not empty, or gone */ }
      }
      const left = verdicts.find((v): v is PromiseRejectedResult => v.status === "rejected");
      if (left) throw left.reason;
    },
  };
}
