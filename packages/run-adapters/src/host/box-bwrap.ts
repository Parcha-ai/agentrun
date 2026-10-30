// The box on Linux: bubblewrap, built and checked here. Written for AgentRun.
//
// The argv is built from an explicit allowlist and checked, structurally and completely, before anything is spawned:
// every isolating flag present, no option outside the set this module uses, the mounts exactly the allowlist computed
// from the spec, and --clearenv followed only by the spec's --setenv pairs. Anything else is refused (box_refused).
//
// The start is synchronous (a CLI's own spawn callback can be): the record's `ahead` (the id and cgroup) is written
// before the spawn. bwrap reports the namespace's pid 1 on --info-fd and then waits on --block-fd; the pid, its start
// time and its pid namespace are recorded (`started`), and only then is the box released, so no process of the harness
// runs before its pid is on disk. A failed `started` kills pid 1 and the harness never runs.
//
// The reap kills the namespace's pid 1, after checking its start time and namespace so a reused pid is never signalled
// (the kernel then kills every process of the namespace, a setsid one included), or writes the cgroup's cgroup.kill.
// Its answer is the kernel's count: the processes left in that pid namespace, or the cgroup's population.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { Writable, Readable } from "node:stream";
import { type Box, type BoxedChild, BoxError, type BoxRecord, type BoxRecorder, type BoxSpec, type Isolation, type Reaped } from "./box.js";

export const BWRAP = "/usr/bin/bwrap";
/** Where the box's sockets are, inside it. */
export const BOX_MODEL_SOCKET = "/run/agentrun/model.sock";
export const BOX_EGRESS_SOCKET = "/run/agentrun/egress.sock";

/** The system, read-only: these directories, or the links a merged-/usr system has in their place. */
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"] as const;
/** The named subset of /etc a harness needs, read-only, each only if the host has it. /etc/passwd and /etc/group are
 *  generated (one line each), never the host's. */
const ETC = ["/etc/ssl/certs", "/etc/ca-certificates", "/etc/hosts", "/etc/nsswitch.conf", "/etc/localtime"] as const;
/** Never bound, not even read-only, nor anything that holds them: the root, /etc whole, the host's secrets and state. */
const FORBIDDEN_ROOTS = ["/", "/etc", "/run", "/var", "/srv", "/home", "/root", "/data", "/proc", "/sys", "/dev", "/boot", "/mnt", "/media", "/opt"] as const;

const INFO_FD = 3;
const BLOCK_FD = 4;
const PASSWD_FD = 5;
const GROUP_FD = 6;

/** A mount the argv makes: [option, ...operands]. */
type Mount = readonly string[];

/** The flags every box carries. */
const FLAGS = ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--die-with-parent", "--new-session", "--disable-userns"] as const;
/** The options this module uses, by arity. Any other option in an argv is refused. */
const ARITY: Record<string, number> = {
  ...Object.fromEntries(FLAGS.map((f) => [f, 0])),
  "--clearenv": 0,
  "--proc": 1,
  "--dev": 1,
  "--tmpfs": 1,
  "--chdir": 1,
  "--info-fd": 1,
  "--block-fd": 1,
  "--bind": 2,
  "--ro-bind": 2,
  "--ro-bind-data": 2,
  "--symlink": 2,
  "--setenv": 2,
};

const isUnder = (path: string, root: string) => path === root || path.startsWith(root === "/" ? "/" : `${root}${sep}`);

/** The server's own home and the CLIs' global config dirs: never bound, nor anything under them. */
function privateRoots(home = homedir()): string[] {
  return [home, `${home}/.claude`, `${home}/.codex`, `${home}/.config`, "/etc/claude-code", "/etc/codex"];
}

/** A path a spec may bind: absolute and normalized, not a forbidden root nor an ancestor of one, not under the
 *  server's home or a CLI's config dir. (Under a forbidden root is allowed: a run's own directory under /data is.) */
function allowedSource(path: string, what: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path) throw new BoxError("box_refused", `${what} ${JSON.stringify(path)} is not an absolute, normalized path`);
  for (const root of FORBIDDEN_ROOTS) if (isUnder(root, path)) throw new BoxError("box_refused", `${what} ${path} is or holds ${root}, which a box never binds`);
  for (const root of privateRoots()) if (isUnder(path, root) || isUnder(root, path)) throw new BoxError("box_refused", `${what} ${path} is or holds ${root}, the server's own`);
  return path;
}

/** The mounts a spec's box gets, in order: the system, /etc's subset and its generated passwd and group, node and the
 *  CLIs, the private /proc, /dev, /tmp and /dev/shm, then the workspace, the homes and the sockets. */
export function boxMounts(spec: BoxSpec, host: { exists(path: string): "dir" | "file" | "link" | null; link(path: string): string } = hostFs): Mount[] {
  const mounts: Mount[] = [];
  for (const path of SYSTEM) {
    const kind = host.exists(path);
    if (kind === "link") mounts.push(["--symlink", host.link(path), path]);
    else if (kind === "dir") mounts.push(["--ro-bind", path, path]);
  }
  for (const path of ETC) if (host.exists(path)) mounts.push(["--ro-bind", path, path]);
  mounts.push(["--ro-bind-data", String(PASSWD_FD), "/etc/passwd"], ["--ro-bind-data", String(GROUP_FD), "/etc/group"]);
  for (const path of spec.readOnly) mounts.push(["--ro-bind", allowedSource(path, "a read-only path"), path]);
  mounts.push(["--proc", "/proc"], ["--dev", "/dev"], ["--tmpfs", "/tmp"], ["--tmpfs", "/dev/shm"]);
  mounts.push(["--bind", allowedSource(spec.workspace, "the workspace"), "/workspace"]);
  for (const [name, path] of Object.entries(spec.homes)) mounts.push(["--bind", allowedSource(path, `home ${name}`), path]);
  mounts.push(["--bind", allowedSource(spec.modelSocket, "the model socket"), BOX_MODEL_SOCKET]);
  if (spec.egressSocket !== undefined) mounts.push(["--bind", allowedSource(spec.egressSocket, "the egress socket"), BOX_EGRESS_SOCKET]);
  return mounts;
}

const hostFs = {
  exists(path: string): "dir" | "file" | "link" | null {
    try {
      const s = lstatSync(path);
      return s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  },
  link: (path: string) => readlinkSync(path),
};

/** The box's whole argv: flags, mounts, the working directory, the environment, the two fds, then the child. */
export function buildBoxArgv(spec: BoxSpec, child: { command: string; args: string[] }): string[] {
  const env = Object.entries(spec.env).flatMap(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new BoxError("box_refused", `the environment name ${JSON.stringify(name)} is not a variable name`);
    return ["--setenv", name, value];
  });
  return [
    ...FLAGS,
    ...boxMounts(spec).flat(),
    "--chdir",
    "/workspace",
    "--clearenv",
    ...env,
    "--info-fd",
    String(INFO_FD),
    "--block-fd",
    String(BLOCK_FD),
    "--",
    child.command,
    ...child.args,
  ];
}

/** Checks an argv against the spec, structurally and completely, and throws box_refused at the first fault: every flag
 *  present; the private /proc; no option this module does not use; the mounts exactly the spec's allowlist, none of them
 *  binding a forbidden root, the server's home or a CLI's config; --clearenv before every --setenv, and the --setenv pairs
 *  exactly the spec's environment; the two fds; and a child after `--`. */
export function checkBoxArgv(argv: readonly string[], spec: BoxSpec): void {
  const refuse = (why: string): never => {
    throw new BoxError("box_refused", `the box's argv is refused: ${why}`);
  };
  const seen = new Set<string>();
  const mounts: string[][] = [];
  const env: [string, string][] = [];
  let clearenvAt = -1;
  let i = 0;
  for (; i < argv.length && argv[i] !== "--"; ) {
    const option = argv[i]!;
    const arity = ARITY[option];
    if (arity === undefined) refuse(`${option} is not an option a box uses`);
    const operands = argv.slice(i + 1, i + 1 + arity!);
    if (operands.length !== arity) refuse(`${option} is missing its operands`);
    if (option === "--setenv") {
      if (clearenvAt < 0) refuse("--setenv before --clearenv");
      env.push([operands[0]!, operands[1]!]);
    } else if (option === "--clearenv") {
      if (clearenvAt >= 0) refuse("--clearenv twice");
      clearenvAt = i;
    } else if (["--bind", "--ro-bind", "--ro-bind-data", "--symlink", "--tmpfs", "--proc", "--dev"].includes(option)) {
      mounts.push([option, ...operands]);
    } else if (option === "--info-fd" && operands[0] !== String(INFO_FD)) refuse(`--info-fd is not ${INFO_FD}`);
    else if (option === "--block-fd" && operands[0] !== String(BLOCK_FD)) refuse(`--block-fd is not ${BLOCK_FD}`);
    else if (option === "--chdir" && operands[0] !== "/workspace") refuse("--chdir is not /workspace");
    else if (seen.has(option) && arity === 0) refuse(`${option} twice`);
    seen.add(option);
    i += 1 + arity!;
  }
  if (argv[i] !== "--" || i + 1 >= argv.length) refuse("no child after --");
  for (const flag of [...FLAGS, "--clearenv", "--info-fd", "--block-fd"]) if (!seen.has(flag)) refuse(`${flag} is missing`);
  // Every bind's source and destination: never a forbidden root or anything holding one, never the server's own.
  for (const m of mounts) {
    for (const path of m[0] === "--ro-bind-data" || m[0] === "--symlink" ? m.slice(2) : m.slice(1)) {
      for (const root of FORBIDDEN_ROOTS) if (path === root && !(m[0] === "--proc" && path === "/proc") && !(m[0] === "--dev" && path === "/dev")) refuse(`${m[0]} names ${root}`);
      if (path === "/" || path === "") refuse(`${m[0]} binds the root`);
      for (const root of privateRoots()) if (isUnder(path, root)) refuse(`${m[0]} ${path} is the server's own (${root})`);
    }
  }
  // Exactly the allowlist: the same mounts, the same number of times, in any order.
  const key = (m: readonly string[]) => JSON.stringify(m);
  const expected = boxMounts(spec).map(key).sort();
  const actual = mounts.map(key).sort();
  if (expected.length !== actual.length || expected.some((m, n) => m !== actual[n])) {
    const extra = actual.filter((m) => !expected.includes(m));
    const missing = expected.filter((m) => !actual.includes(m));
    refuse(`the mounts are not the allowlist (extra: ${extra.join(" ") || "none"}; missing: ${missing.join(" ") || "none"})`);
  }
  // The environment: exactly the spec's.
  const want = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`).sort();
  const got = env.map(([k, v]) => `${k}=${v}`).sort();
  if (want.length !== got.length || want.some((e, n) => e !== got[n])) refuse("the --setenv pairs are not the spec's environment");
}

/** /proc/<pid>/stat's start time (clock ticks since boot), or undefined when the process is gone. */
export function startTimeOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** /proc/<pid>/ns/pid, as `pid:[<inode>]`, or undefined when the process is gone. */
export function pidnsOf(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`);
  } catch {
    return undefined;
  }
}

/** The processes on this host in the pid namespace `pidns`, by the kernel's own /proc. A process this one may not
 *  inspect (one that made itself non-dumpable) has no readable namespace link; its /proc/<pid>/status (always readable)
 *  still says how deep its pid namespace is (NSpid) and whose it is. A box's processes are this uid's in a nested
 *  namespace, so one of those whose link cannot be read counts as left: an unread process is never taken for gone. One
 *  in this process's own namespace, or another user's, is no box of this server's. */
export function countInPidns(pidns: string): number {
  const uid = process.getuid?.();
  let n = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readlinkSync(`/proc/${entry}/ns/pid`) === pidns) n++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") continue; // gone between the listing and the read
      try {
        const status = readFileSync(`/proc/${entry}/status`, "utf8");
        const nspid = /^NSpid:\s*(.*)$/m.exec(status)?.[1]?.trim().split(/\s+/) ?? [];
        const owner = Number(/^Uid:\s*(\d+)/m.exec(status)?.[1]);
        if (nspid.length !== 1 && owner === uid) n++;
      } catch {
        // gone
      }
    }
  }
  return n;
}

/** The cgroup's population, from cgroup.events; undefined when the cgroup is gone (rmdir succeeds only when empty). */
function populated(cgroup: string): boolean | undefined {
  try {
    return /^populated 1$/m.test(readFileSync(`${cgroup}/cgroup.events`, "utf8"));
  } catch {
    return undefined;
  }
}

export interface BwrapBoxOptions {
  /** bwrap's path; /usr/bin/bwrap. */
  bwrap?: string;
  /** pids.max for a run's cgroup. */
  pidsMax?: number;
  /** How long a reap waits for the kernel to empty the box. */
  reapMs?: number;
  /** For tests: the spawn (node's by default). */
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** What the start probe proved (the caller's). */
  isolation?: Isolation;
}

/** The passwd and group lines a box gets: its own uid and gid, named `box`, with /workspace as home. */
function identity(): { passwd: string; group: string } {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  return { passwd: `box:x:${uid}:${gid}:box:/workspace:/bin/sh\n`, group: `box:x:${gid}:\n` };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let self: { pid: number; startTime: string } | undefined;
/** This process, as a record's writer: its pid and start time, read once. */
function writer(): { pid: number; startTime: string } {
  if (self === undefined) {
    const startTime = startTimeOf(process.pid);
    if (startTime === undefined) throw new BoxError("box_start_failed", "this process's own start time cannot be read from /proc/self/stat");
    self = { pid: process.pid, startTime };
  }
  return { ...self };
}

/** Reads bwrap's --info-fd JSON until it holds child-pid, or rejects when bwrap ends first. */
function readInfo(stream: Readable, exited: Promise<unknown>, stderr: () => string): Promise<number> {
  return new Promise((resolveInfo, reject) => {
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const m = /"child-pid"\s*:\s*(\d+)/.exec(text);
      if (m) {
        stream.off("data", onData);
        resolveInfo(Number(m[1]));
      }
    };
    stream.on("data", onData);
    void exited.then(() => {
      const err = stderr();
      const code = /setting up uid map: Permission denied|No permissions to creat(e|ing) new namespace|unprivileged user namespaces/i.test(err) ? "bwrap_userns_denied" : "box_start_failed";
      reject(new BoxError(code, `bwrap ended before the box started: ${err.trim().slice(0, 300) || "(no output)"}`));
    });
  });
}

export function bwrapBox(options: BwrapBoxOptions = {}): Box {
  const bwrap = options.bwrap ?? BWRAP;
  const spawnChild = options.spawn ?? nodeSpawn;
  const reapMs = options.reapMs ?? 5000;

  async function reap(record: BoxRecord): Promise<Reaped> {
    if (record.cgroup !== undefined) {
      if (populated(record.cgroup) === undefined) return { empty: true, left: 0, by: "cgroup" };
      try {
        writeFileSync(`${record.cgroup}/cgroup.kill`, "1");
      } catch {
        // the kill is retried below by the population check's timeout; an unwritable cgroup.kill leaves it populated
      }
      const until = Date.now() + reapMs;
      while (populated(record.cgroup) === true && Date.now() < until) await sleep(10);
      if (populated(record.cgroup) === true) {
        const left = readFileSync(`${record.cgroup}/cgroup.procs`, "utf8").split("\n").filter(Boolean).length;
        return { empty: false, left: Math.max(left, 1), by: "cgroup" };
      }
      try {
        rmdirSync(record.cgroup);
      } catch {
        // populated 0 is the kernel's word; a cgroup that will not go is the sweep's
      }
      return { empty: true, left: 0, by: "cgroup" };
    }
    if (record.pid !== undefined && record.pidns !== undefined) {
      // Only the recorded process: the same start time and the same namespace, so a reused pid is never signalled.
      if (startTimeOf(record.pid) === record.startTime && pidnsOf(record.pid) === record.pidns) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          // gone between the check and the kill
        }
      }
      const until = Date.now() + reapMs;
      let left = countInPidns(record.pidns);
      while (left > 0 && Date.now() < until) {
        await sleep(10);
        left = countInPidns(record.pidns);
      }
      return { empty: left === 0, left, by: "pidns" };
    }
    return { empty: false, left: 0, by: "none" };
  }

  function start(spec: BoxSpec, child: { command: string; args: string[] }, recorder: BoxRecorder): BoxedChild {
    const argv = buildBoxArgv(spec, child);
    checkBoxArgv(argv, spec);
    const record: BoxRecord = {
      id: randomUUID(),
      ...(spec.cgroup !== undefined ? { cgroup: spec.cgroup } : {}),
      writer: writer(),
    };
    // Before the spawn, with nothing awaited in between: the box is on disk before it exists.
    recorder.ahead({ ...record });
    if (spec.cgroup !== undefined) {
      mkdirSync(spec.cgroup, { recursive: false });
      if (options.pidsMax !== undefined) writeFileSync(`${spec.cgroup}/pids.max`, String(options.pidsMax));
    }
    // With a cgroup, the box's first process joins it before it execs bwrap, so every process of the box is born in it.
    const [command, args] =
      spec.cgroup !== undefined ? ["/bin/sh", ["-c", 'echo 0 > "$0/cgroup.procs" && exec "$@"', spec.cgroup, bwrap, ...argv]] : [bwrap, argv];
    const proc = spawnChild(command, args, {
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
      detached: true,
    });
    let tail = "";
    proc.stderr?.on("data", (d: Buffer) => (tail = (tail + d.toString("utf8")).slice(-4000)));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      proc.once("close", (code, signal) => resolveExit({ code, signal }));
      proc.once("error", () => resolveExit({ code: null, signal: null }));
    });
    const fds = proc.stdio as unknown as (Readable & Writable)[];
    const { passwd, group } = identity();
    fds[PASSWD_FD]?.end(passwd);
    fds[GROUP_FD]?.end(group);
    let done = false;
    void exited.then(() => (done = true));
    const killBox = () => {
      if (record.pid !== undefined && startTimeOf(record.pid) === record.startTime) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          // gone
        }
      }
      try {
        proc.kill("SIGKILL");
      } catch {
        // gone
      }
    };
    const ready = (async (): Promise<BoxRecord> => {
      const pid = await readInfo(fds[INFO_FD]!, exited, () => tail);
      const startTime = startTimeOf(pid);
      const pidns = pidnsOf(pid);
      if (startTime === undefined || pidns === undefined) {
        killBox();
        throw new BoxError("box_start_failed", `the box's pid 1 (${pid}) was gone before it could be recorded`);
      }
      Object.assign(record, { pid, startTime, pidns });
      try {
        await recorder.started({ ...record });
      } catch (error) {
        // Never released: pid 1 dies, and the harness never ran.
        killBox();
        await reap({ ...record });
        throw new BoxError("box_record_failed", `the box's record could not be written; the box was killed before the harness ran: ${String((error as Error)?.message ?? error)}`, { cause: error });
      }
      fds[BLOCK_FD]!.end("x");
      return { ...record };
    })();
    ready.catch(() => {}); // the caller's to observe; never an unhandled rejection here
    return {
      child: proc,
      exited,
      stderrTail: () => tail,
      alive: () => !done,
      kill: killBox,
      get record() {
        return { ...record };
      },
      ready,
    };
  }

  return { isolation: options.isolation ?? { mode: "bwrap", cgroup: false }, start, reap };
}

/** bwrap's own state on this host: missing, setuid (refused: a box never relies on a setuid bwrap), or usable. */
export function bwrapState(path = BWRAP): { ok: true } | { ok: false; error: "bwrap_missing" | "bwrap_setuid"; detail: string } {
  let s;
  try {
    s = statSync(path);
  } catch {
    return { ok: false, error: "bwrap_missing", detail: `${path} is not installed` };
  }
  if (s.mode & 0o4000) return { ok: false, error: "bwrap_setuid", detail: `${path} is setuid: a box never uses a setuid bwrap` };
  return { ok: true };
}

