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
import { dirname, resolve, sep } from "node:path";
import type { Writable, Readable } from "node:stream";
import { type Box, type BoxedChild, BoxError, type BoxRecord, type BoxRecorder, type BoxSpec, type Isolation, type Reaped } from "./box.js";
import { BOX_FORWARD, BOX_LOOPBACK, forwardChild, type ForwardListen, parseForward } from "./box-forward.js";
import { BOX_EGRESS_SOCKET, BOX_MODEL_SOCKET } from "./machine.js";

export const BWRAP = "/usr/bin/bwrap";

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
  // The workspace at its own path (the adapters pass host paths through untouched), and at /workspace as well.
  mounts.push(["--bind", allowedSource(spec.workspace, "the workspace"), spec.workspace], ["--bind", spec.workspace, "/workspace"]);
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
    spec.workspace,
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
/** The forwarder's `--listen` operands for `spec`: the model socket's, then the egress proxy's when the box has one. */
/** The sockets the forwarder (./box-forward.ts) serves for `spec`, in the box at its own ports: the model front's, then the
 *  egress proxy's when the box has one. A port that is not one, or an egress socket without its port, is refused. The
 *  box's first command for a harness is `forwardChild(harness, boxListens(spec))`. */
export function boxListens(spec: BoxSpec): ForwardListen[] {
  const port = (value: number | undefined, what: string) => {
    if (!Number.isInteger(value) || value! < 1 || value! > 65535) throw new BoxError("box_refused", `the ${what} port ${JSON.stringify(value)} is not a port`);
    return value!;
  };
  return [
    { port: port(spec.modelPort, "model"), socket: BOX_MODEL_SOCKET },
    ...(spec.egressSocket === undefined ? [] : [{ port: port(spec.egressPort, "egress"), socket: BOX_EGRESS_SOCKET }]),
  ];
}

/** `hidden`: paths a box must never see, whatever it binds. Serve's data root is one: a run's mark and command records
 *  live under it, and pi-durable-disk forgets a record written in another pid namespace only by its rule that a reader
 *  whose PID 1 started after the record was written is a later incarnation, which holds only while no box (a child
 *  namespace whose PID 1 also starts later) can read those records. */
export function checkBoxArgv(argv: readonly string[], spec: BoxSpec, options: { hidden?: readonly string[] } = {}): void {
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
    else if (option === "--chdir" && operands[0] !== spec.workspace) refuse("--chdir is not the workspace");
    else if (seen.has(option) && arity === 0) refuse(`${option} twice`);
    seen.add(option);
    i += 1 + arity!;
  }
  if (argv[i] !== "--" || i + 1 >= argv.length) refuse("no child after --");
  // The command: this server's node running this kernel's forwarder, serving exactly the spec's sockets, then a harness.
  // Anything else as the box's first command (another script, one more socket, a socket of the host's) never runs.
  // The forwarder's own arguments are read by its own parser (parseForward), never a second one here.
  const command = argv.slice(i + 1);
  if (command[0] !== process.execPath) refuse(`the box's first command is ${JSON.stringify(command[0])}, not this server's node`);
  if (command[1] !== BOX_FORWARD) refuse(`the box's first command runs ${JSON.stringify(command[1])}, not this kernel's box-forward.js`);
  let forwarded: ReturnType<typeof parseForward>;
  try {
    forwarded = parseForward(command.slice(2));
  } catch (error) {
    return refuse(`the forwarder's arguments do not parse: ${(error as Error).message}`);
  }
  const listens = forwarded.listen.map((l) => `${l.port}=${l.socket}`);
  const wanted = boxListens(spec).map((l) => `${l.port}=${l.socket}`);
  if (listens.length !== wanted.length || listens.some((listen, n) => listen !== wanted[n])) refuse(`the forwarder's --listen operands are not the spec's sockets: ${listens.join(" ") || "none"}`);
  for (const flag of [...FLAGS, "--clearenv", "--info-fd", "--block-fd"]) if (!seen.has(flag)) refuse(`${flag} is missing`);
  // Every bind's source and destination: never a forbidden root or anything holding one, never the server's own.
  for (const m of mounts) {
    for (const path of m[0] === "--ro-bind-data" || m[0] === "--symlink" ? m.slice(2) : m.slice(1)) {
      for (const root of FORBIDDEN_ROOTS) if (path === root && !(m[0] === "--proc" && path === "/proc") && !(m[0] === "--dev" && path === "/dev")) refuse(`${m[0]} names ${root}`);
      if (path === "/" || path === "") refuse(`${m[0]} binds the root`);
      for (const root of privateRoots()) if (isUnder(path, root)) refuse(`${m[0]} ${path} is the server's own (${root})`);
    }
  }
  // A bind whose host source is a hidden path or holds one (its parent, or the root) shows it to the box; one under it does
  // not. Only a bind's source is the host's: a --tmpfs, --proc or --dev, or a bind's destination, shows nothing of it.
  for (const m of mounts) {
    if (m[0] !== "--bind" && m[0] !== "--ro-bind") continue;
    for (const hidden of options.hidden ?? []) if (isUnder(hidden, m[1]!)) refuse(`${m[0]} ${m[1]} shows ${hidden}, which a box never sees`);
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

/** A process's parent and start time, from <proc>/<pid>/stat (readable for any process), or undefined. */
function statOf(pid: number, proc: string): { parent: number; startTime: string } | undefined {
  try {
    const stat = readFileSync(`${proc}/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { parent: Number(fields[1]), startTime: fields[19]! };
  } catch {
    return undefined;
  }
}

/** The processes on this host in the pid namespace `pidns`, by the kernel's own /proc. A process this one may not
 *  inspect (one that made itself non-dumpable, as a browser's sandbox does) has no readable namespace link. Every
 *  process of a box's namespace descends from its pid 1 (orphans there are reparented to it), which stays, a zombie at
 *  the last, until the namespace is empty. So an unreadable process of this uid in a nested namespace counts as left:
 *  when its parents lead to `pid1` as recorded (its pid AND its start time); when `pid1` is not known; or when its parent
 *  chain cannot be read to the end (a link unreadable or gone mid-walk): an unread process of the box is never taken for
 *  gone. A chain that reaches the recorded pid carrying another start time (the pid reused after the box died) is not the
 *  box's. Another user's process, or one of this process's own namespace, is no box of this server's. */
export function countInPidns(pidns: string, pid1?: { pid: number; startTime?: string }, proc = "/proc"): number {
  const uid = process.getuid?.();
  let n = 0;
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readlinkSync(`${proc}/${entry}/ns/pid`) === pidns) n++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") continue; // gone between the listing and the read
      let status: string;
      try {
        status = readFileSync(`${proc}/${entry}/status`, "utf8");
      } catch {
        continue; // gone
      }
      const nspid = /^NSpid:\s*(.*)$/m.exec(status)?.[1]?.trim().split(/\s+/) ?? [];
      const owner = Number(/^Uid:\s*(\d+)/m.exec(status)?.[1]);
      if (nspid.length === 1 || owner !== uid) continue;
      if (pid1 === undefined) {
        n++;
        continue;
      }
      for (let p = Number(entry), hops = 0; ; hops++) {
        const s = statOf(p, proc);
        if (s === undefined || hops > 4096) {
          n++; // the chain cannot be read to its end: unknown, so left
          break;
        }
        if (p === pid1.pid) {
          if (s.startTime === pid1.startTime) n++;
          break;
        }
        if (s.parent <= 1) break;
        p = s.parent;
      }
    }
  }
  return n;
}

/** The cgroup's population, from its cgroup.events line `populated 0|1` (its descendants' processes included). "gone"
 *  only when the cgroup does not exist (rmdir succeeds only on an empty one) while the delegated root still reads: a
 *  root unmounted, moved or misnamed makes every box's cgroup missing, which proves nothing. Anything else that cannot
 *  be read is "unknown", never taken for empty. */
function populated(cgroup: string, root: string | undefined): boolean | "gone" | "unknown" {
  let text: string;
  try {
    text = readFileSync(`${cgroup}/cgroup.events`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || root === undefined) return "unknown";
    try {
      readFileSync(`${root}/cgroup.procs`, "utf8");
    } catch {
      return "unknown";
    }
    return "gone";
  }
  const line = text.split("\n").find((l) => l.startsWith("populated "));
  return line === "populated 1" ? true : line === "populated 0" ? false : "unknown";
}

/** A box's cgroup, refused by name unless it is an absolute, normalized path strictly under the delegated root (at a
 *  "/" boundary: "<root>x/a" is not under "<root>"), and not the root itself. */
function checkCgroup(cgroup: string, root: string | undefined): void {
  const refuse = (why: string): never => {
    throw new BoxError("box_refused", `the box's cgroup ${JSON.stringify(cgroup)} is refused: ${why}`);
  };
  if (root === undefined) refuse("no delegated cgroup root is configured");
  if (!cgroup.startsWith("/") || resolve(cgroup) !== cgroup) refuse("not an absolute, normalized path");
  if (cgroup === root) refuse("it is the delegated root itself");
  if (!cgroup.startsWith(`${root}/`)) refuse(`it is not under the delegated root ${root}`);
}

export interface BwrapBoxOptions {
  /** bwrap's path; /usr/bin/bwrap. */
  bwrap?: string;
  /** pids.max for a run's cgroup. */
  pidsMax?: number;
  /** The delegated cgroup v2 subtree (the operator's), under which every box's cgroup is made. A spec with a cgroup is
   *  refused without it, and a reap reads a missing box cgroup as emptied only while this root itself reads. */
  cgroupRoot?: string;
  /** Paths no box may see (serve's data root): a bind that is one or holds one is refused before the spawn. */
  hidden?: readonly string[];
  /** How long a reap waits for the kernel to empty the box. */
  reapMs?: number;
  /** For tests: the spawn (node's by default). */
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** What the start probe proved (the caller's). */
  isolation?: Isolation;
  /** For tests: the argv builder (buildBoxArgv). Whatever it returns is still checked before the spawn. */
  buildArgv?: (spec: BoxSpec, child: { command: string; args: string[] }) => string[];
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
      const root = options.cgroupRoot;
      if (populated(record.cgroup, root) === "gone") return { empty: true, left: 0, by: "cgroup" };
      try {
        writeFileSync(`${record.cgroup}/cgroup.kill`, "1");
      } catch {
        // the kill is retried below by the population check's timeout; an unwritable cgroup.kill leaves it populated
      }
      const until = Date.now() + reapMs;
      while (populated(record.cgroup, root) !== false && populated(record.cgroup, root) !== "gone" && Date.now() < until) await sleep(10);
      const last = populated(record.cgroup, root);
      if (last === "gone") return { empty: true, left: 0, by: "cgroup" };
      // Populated, or a population that cannot be read: not empty. Unknown is never gone, and nothing is signalled by pid.
      if (last !== false) {
        let left = 1;
        try {
          left = Math.max(readFileSync(`${record.cgroup}/cgroup.procs`, "utf8").split("\n").filter(Boolean).length, 1);
        } catch {
          // its processes cannot be listed either: at least one
        }
        return { empty: false, left, by: "cgroup" };
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
      const pid1 = { pid: record.pid, ...(record.startTime !== undefined ? { startTime: record.startTime } : {}) };
      let left = countInPidns(record.pidns, pid1);
      while (left > 0 && Date.now() < until) {
        await sleep(10);
        left = countInPidns(record.pidns, pid1);
      }
      return { empty: left === 0, left, by: "pidns" };
    }
    return { empty: false, left: 0, by: "none" };
  }

  function start(spec: BoxSpec, child: { command: string; args: string[] }, recorder: BoxRecorder): BoxedChild {
    const argv = (options.buildArgv ?? buildBoxArgv)(spec, child);
    checkBoxArgv(argv, spec, { hidden: options.hidden });
    const record: BoxRecord = {
      id: randomUUID(),
      ...(spec.cgroup !== undefined ? { cgroup: spec.cgroup } : {}),
      writer: writer(),
    };
    // The cgroup is made before the record names it: a record must never name a cgroup this box did not make (another
    // run's), since a reap of that record would kill whatever is in it. The parents between the delegated root and the
    // box's own cgroup may be made recursively; the box's own cgroup (the leaf) is made NON-recursively, so one that
    // already exists is refused (EEXIST), never adopted. A crash between the two leaves an empty cgroup, the sweep's.
    if (spec.cgroup !== undefined) {
      checkCgroup(spec.cgroup, options.cgroupRoot);
      mkdirSync(dirname(spec.cgroup), { recursive: true });
      try {
        mkdirSync(spec.cgroup, { recursive: false });
      } catch (error) {
        throw new BoxError("box_refused", `the box's cgroup ${spec.cgroup} could not be made${(error as NodeJS.ErrnoException).code === "EEXIST" ? ": it already exists" : ""}`, { cause: error });
      }
      if (options.pidsMax !== undefined) writeFileSync(`${spec.cgroup}/pids.max`, String(options.pidsMax));
    }
    // Before the spawn, with nothing awaited in between: the box is on disk before it exists.
    try {
      recorder.ahead({ ...record });
    } catch (error) {
      if (spec.cgroup !== undefined) {
        try {
          rmdirSync(spec.cgroup);
        } catch {
          // empty and unrecorded: the sweep's
        }
      }
      throw error;
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


/** Where the start probe listens on this host: the host's loopback. Inside the box the same address (BOX_LOOPBACK) is the
 *  box's own loopback, which is what the probe proves: the host's listener does not answer there. */
const PROBE_HOST = "127.0.0.1"; // key-gate: loopback-rule the probe listens on host loopback to prove the box cannot reach it

/** The start probe: a box built exactly as a harness's is, with node as its child, checked from inside by behaviour:
 *  pid 1 is the box's own (bwrap), /data is absent, and a listener on this host's loopback does not answer. Fails
 *  closed: any failure is `unavailable` with its named cause. `scratch` is a directory the probe may make a
 *  workspace in (it is removed after); node's install prefix is bound read-only, so a node under the server's home
 *  cannot be boxed and the probe says so. */
export async function probeBox(options: { scratch: string; bwrap?: string; reapMs?: number }): Promise<Isolation> {
  const bwrap = options.bwrap ?? BWRAP;
  const state = bwrapState(bwrap);
  if (!state.ok) return { mode: "unavailable", error: state.error, detail: state.detail };
  const { createServer } = await import("node:net");
  const { mkdtempSync, rmSync, writeFileSync: write } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const listener = createServer((socket) => socket.end("host"));
  await new Promise<void>((resolveListen) => listener.listen(0, PROBE_HOST, resolveListen));
  const port = (listener.address() as { port: number }).port;
  const dir = mkdtempSync(join(options.scratch, "box-probe-"));
  const box = bwrapBox({ bwrap, reapMs: options.reapMs ?? 5000 });
  try {
    const socket = join(dir, "model.sock");
    write(socket, "");
    const spec: BoxSpec = {
      workspace: join(dir, "work"),
      homes: {},
      readOnly: [dirname(dirname(process.execPath)), BOX_FORWARD],
      modelSocket: socket,
      modelPort: 1,
      env: { PATH: "/usr/bin:/bin" },
    };
    mkdirSync(spec.workspace);
    const script = `const fs = require("node:fs"); const net = require("node:net");
const out = { pid1: fs.readFileSync("/proc/1/comm", "utf8").trim(), data: fs.existsSync("/data") };
const s = net.connect(${port}, ${JSON.stringify(BOX_LOOPBACK)});
s.on("connect", () => { out.loopback = "answered"; console.log(JSON.stringify(out)); process.exit(0); });
s.on("error", (e) => { out.loopback = e.code; console.log(JSON.stringify(out)); process.exit(0); });`;
    let boxed: BoxedChild;
    try {
      boxed = box.start(spec, forwardChild({ command: process.execPath, args: ["-e", script] }, boxListens(spec)), { ahead() {}, async started() {} });
    } catch (error) {
      return { mode: "unavailable", error: error instanceof BoxError ? error.code : "box_probe_failed", detail: String((error as Error)?.message ?? error) };
    }
    let out = "";
    boxed.child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    try {
      await boxed.ready;
    } catch (error) {
      return { mode: "unavailable", error: error instanceof BoxError ? error.code : "box_probe_failed", detail: String((error as Error)?.message ?? error) };
    }
    const timer = setTimeout(() => boxed.kill(), 10_000);
    await boxed.exited;
    clearTimeout(timer);
    const reaped = await box.reap(boxed.record);
    let seen: { pid1?: string; data?: boolean; loopback?: string } = {};
    try {
      seen = JSON.parse(out.trim().split("\n").pop() ?? "{}");
    } catch {
      // judged below
    }
    const wrong = [
      seen.pid1 !== "bwrap" ? `pid 1 inside is ${JSON.stringify(seen.pid1)}, not the box's` : "",
      seen.data !== false ? "/data is visible inside" : "",
      seen.loopback === undefined || seen.loopback === "answered" ? `the host's loopback ${seen.loopback === "answered" ? "answered" : "was not tried"}` : "",
      !reaped.empty ? `the reap left ${reaped.left} process(es)` : "",
    ].filter(Boolean);
    if (wrong.length) return { mode: "unavailable", error: "box_probe_failed", detail: `${wrong.join("; ")}${boxed.stderrTail() ? `; bwrap said: ${boxed.stderrTail().trim().slice(0, 200)}` : ""}` };
    return { mode: "bwrap", cgroup: false };
  } finally {
    listener.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
