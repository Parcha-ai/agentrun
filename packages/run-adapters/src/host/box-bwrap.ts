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
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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

/** A path a spec may bind: absolute and normalized, not a forbidden root nor an ancestor of one, never the server's home
 *  or a CLI's config dir nor anything that holds one. (Under a forbidden root is allowed: a run's own directory under
 *  /data is. What may be bound under the server's home is checkBoxArgv's to judge, by the session and the runtime.) */
function allowedSource(path: string, what: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path) throw new BoxError("box_refused", `${what} ${JSON.stringify(path)} is not an absolute, normalized path`);
  for (const root of FORBIDDEN_ROOTS) if (isUnder(root, path)) throw new BoxError("box_refused", `${what} ${path} is or holds ${root}, which a box never binds`);
  for (const root of privateRoots()) if (isUnder(root, path)) throw new BoxError("box_refused", `${what} ${path} is or holds ${root}, the server's own`);
  return path;
}

/**
 * Where this server's runtime lies, computed here from this process and this kernel, never from a spec: the only places
 * under the server's home a box may read.
 *  - `prefix`: node's install prefix (realpath of process.execPath's grandparent); `npmrc` when it holds etc/npmrc, which
 *    can hold registry tokens.
 *  - `packages`: the node_modules DIRECTORY the kernel was installed from: the outermost one on realpath(BOX_FORWARD);
 *    with none on it (a workspace link: a source checkout), the node_modules of the OUTERMOST ancestor of it that holds
 *    one, strictly below the server's home (so a stray ~/node_modules is never one). npm makes packages/<x>/node_modules
 *    as soon as one dependency cannot be hoisted, so the nearest one would miss the hoisted CLIs.
 *  - `forward`: realpath(BOX_FORWARD), as a file.
 */
export function runtimeRoots(runtime: { execPath: string; forward: string }, home: string): { prefix: string; npmrc: boolean; packages?: string; forward: string } {
  const prefix = resolvedSource(dirname(dirname(runtime.execPath)), "node's install prefix");
  const forward = resolvedSource(runtime.forward, "the box's forwarder");
  const parts = forward.split(sep);
  const first = parts.indexOf("node_modules");
  let packages = first > 0 ? parts.slice(0, first + 1).join(sep) : undefined;
  if (packages === undefined) {
    for (let at = dirname(forward); at !== dirname(at); at = dirname(at)) {
      if (isUnder(at, home) && at !== home && hostFs.exists(join(at, "node_modules")) === "dir") packages = join(at, "node_modules");
    }
  }
  return { prefix, npmrc: hostFs.exists(join(prefix, "etc", "npmrc")) !== null, ...(packages !== undefined ? { packages } : {}), forward };
}

/**
 * A bind's host source as the kernel will open it, every link in it followed (realpath). A path not there yet resolves
 * through its nearest existing parent (bwrap then fails on it by name). A link that leads nowhere is refused: what it
 * names could appear between this check and the bind.
 */
export function resolvedSource(path: string, what: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new BoxError("box_refused", `${what} ${path} cannot be resolved (${code})`, { cause: error });
    if (hostFs.exists(path) === "link") throw new BoxError("box_refused", `${what} ${path} is a link that leads nowhere`);
    const parent = dirname(path);
    return parent === path ? path : join(resolvedSource(parent, what), basename(path));
  }
}

/**
 * The mounts a spec's box gets, in order: the private /proc, /dev, /tmp and /dev/shm FIRST, so that a later mount never
 * hides a bind under them (a node, a CLI or a workspace under the host's /tmp); then the system, /etc's subset and its
 * generated passwd and group, node and the CLIs, the workspace, the homes and the sockets.
 *
 * Every bind's host source is the RESOLVED path (`resolvedSource`), checked as resolved, and bound at the path as given:
 * a link to the server's home is refused by what it leads to, and bwrap is handed the very path that was checked, while
 * the box sees each path where its argv and environment name it (node, the forwarder, the workspace, the homes).
 * What is left: a parent of a source swapped for a link after this resolve and before bwrap's bind. The sources are the
 * host's own choice (machine.ts), and no read-only source may sit under serve's data root (checkBoxArgv's `hidden`),
 * where every box's writable tree lives; so only a process of the server's own uid outside every box could swap one, and
 * that process could read what the box would have anyway.
 */
export function boxMounts(
  spec: BoxSpec,
  host: { exists(path: string): "dir" | "file" | "link" | null; link(path: string): string; real(path: string, what: string): string } = hostFs,
): Mount[] {
  /** A bind of `path` as given: its resolved source, checked both as given and as resolved, at the given path. */
  const bind = (option: "--bind" | "--ro-bind", path: string, what: string, at = path): Mount => [option, allowedSource(host.real(allowedSource(path, what), what), what), at];
  const mounts: Mount[] = [["--proc", "/proc"], ["--dev", "/dev"], ["--tmpfs", "/tmp"], ["--tmpfs", "/dev/shm"]];
  for (const path of SYSTEM) {
    const kind = host.exists(path);
    if (kind === "link") mounts.push(["--symlink", host.link(path), path]);
    else if (kind === "dir") mounts.push(["--ro-bind", host.real(path, "the system's"), path]);
  }
  for (const path of ETC) if (host.exists(path)) mounts.push(["--ro-bind", host.real(path, "the system's"), path]);
  mounts.push(["--ro-bind-data", String(PASSWD_FD), "/etc/passwd"], ["--ro-bind-data", String(GROUP_FD), "/etc/group"]);
  for (const path of spec.readOnly) mounts.push(bind("--ro-bind", path, "a read-only path"));
  // The workspace at its own path (the adapters pass host paths through untouched), and at /workspace as well.
  mounts.push(bind("--bind", spec.workspace, "the workspace"), bind("--bind", spec.workspace, "the workspace", "/workspace"));
  for (const [name, path] of Object.entries(spec.homes)) mounts.push(bind("--bind", path, `home ${name}`));
  mounts.push(bind("--bind", spec.modelSocket, "the model socket", BOX_MODEL_SOCKET));
  if (spec.egressSocket !== undefined) mounts.push(bind("--bind", spec.egressSocket, "the egress socket", BOX_EGRESS_SOCKET));
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
  real: resolvedSource,
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
    // Nothing in a box holds the power to bind below 1024: the forwarder would die inside it, so it is refused here.
    if (value! < 1024) throw new BoxError("box_refused", `the ${what} port ${value} is below 1024, which the box's forwarder has no power to listen on`);
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
export function checkBoxArgv(
  argv: readonly string[],
  spec: BoxSpec,
  options: {
    hidden?: readonly string[];
    /** For tests: the server's home (default: this process's). */
    home?: string;
    /** For tests: this server's node and forwarder (default: process.execPath and BOX_FORWARD). */
    runtime?: { execPath: string; forward: string };
  } = {},
): void {
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
    }
  }
  // A mount made after a bind under it hides that bind (a --tmpfs /tmp over a node or a workspace bound under /tmp).
  for (const [n, m] of mounts.entries()) {
    if (m[0] !== "--tmpfs" && m[0] !== "--proc" && m[0] !== "--dev") continue;
    const under = mounts.slice(0, n).find((earlier) => earlier[0] !== "--tmpfs" && earlier[0] !== "--proc" && earlier[0] !== "--dev" && isUnder(earlier.at(-1)!, m[1]!));
    if (under) refuse(`${m[0]} ${m[1]} comes after ${under[0]} to ${under.at(-1)}, which it would hide`);
  }
  // Where each bind may come from, every path compared as resolved, as the sources are (resolvedSource).
  const home = resolvedSource(options.home ?? homedir(), "the server's home");
  const configs = privateRoots(home).filter((root) => root !== home).map((root) => resolvedSource(root, "a CLI's config"));
  const hidden = (options.hidden ?? []).map((path) => resolvedSource(path, "the hidden path"));
  const session = resolvedSource(allowedSource(spec.session, "the session"), "the session");
  const runtime = runtimeRoots(options.runtime ?? { execPath: process.execPath, forward: BOX_FORWARD }, home);
  const shown = (path: string, real: string) => (real !== path ? `${path} (${real})` : path);
  // The session is lent whole: it never is, nor holds, a hidden path (a run's store, its process log, another run).
  for (const path of hidden) if (isUnder(path, session)) refuse(`the session ${session} is or holds ${path}, which a box never sees`);
  // The workspace and every home lie at or under the session: never a sibling run's directory, a run's own files
  // beside the session, or anything of the server's home outside it.
  for (const [what, path] of [["the workspace", spec.workspace], ...Object.entries(spec.homes).map(([name, home]) => [`home ${name}`, home])] as const) {
    const real = resolvedSource(path, what);
    if (!isUnder(real, session)) refuse(`${what} ${shown(path, real)} is not under the session ${session}, the one directory lent to this run`);
  }
  // Under serve's data root (hidden), the server's home or a CLI's config, a writable bind is the session's (the
  // workspace and the homes, under it by the rule above) or one of the spec's own sockets, and only while the session
  // itself lies under the data root. A read-only bind is never under the data root (a run's files live there: one run
  // could swap a link in what another run's box reads) nor a CLI's config, and under the server's home only node's
  // install prefix, the kernel's packages and its forwarder (runtimeRoots).
  const lent = hidden.some((root) => isUnder(session, root) && session !== root);
  const sockets = [[BOX_MODEL_SOCKET, spec.modelSocket], ...(spec.egressSocket !== undefined ? [[BOX_EGRESS_SOCKET, spec.egressSocket]] : [])].map(([at, path]) => `${at}=${resolvedSource(path!, "a socket")}`);
  for (const m of mounts) {
    if (m[0] !== "--bind" && m[0] !== "--ro-bind") continue;
    const [option, source, at] = m as [string, string, string];
    const named = `${option} ${shown(at, source)}`;
    // A bind whose host source is a hidden path, the server's home or a CLI's config, or holds one, shows it.
    for (const root of hidden) if (isUnder(root, source)) refuse(`${named} shows ${root}, which a box never sees`);
    for (const root of [home, ...configs]) if (isUnder(root, source)) refuse(`${named} is or holds ${root}, the server's own`);
    const data = hidden.find((root) => isUnder(source, root));
    const config = configs.find((root) => isUnder(source, root));
    if (option === "--ro-bind") {
      if (data !== undefined) refuse(`a read-only path ${shown(at, source)} is under ${data}, where a run's files live: put the data root outside node's prefix and the installed packages`);
      if (config !== undefined) refuse(`a read-only path ${shown(at, source)} is under ${config}, a CLI's config`);
      if (!isUnder(source, home)) continue;
      if (isUnder(source, runtime.prefix)) {
        if (runtime.npmrc) refuse(`a read-only path ${shown(at, source)} is under node's install prefix ${runtime.prefix}, which holds etc/npmrc (it can hold registry tokens): install node outside the server's home, or remove that file`);
        continue;
      }
      if ((runtime.packages !== undefined && isUnder(source, runtime.packages)) || source === runtime.forward) continue;
      refuse(`a read-only path ${shown(at, source)} is under the server's home ${home}, outside node's install prefix (${runtime.prefix}) and the kernel's packages (${runtime.packages ?? "none found"})`);
    }
    if (config !== undefined) refuse(`${named} is under ${config}, a CLI's config`);
    if (sockets.includes(`${at}=${source}`)) continue;
    if ((data !== undefined || isUnder(source, home)) && !lent) {
      refuse(`${named} is under ${data ?? home}, and the session ${session} is not under the data root${hidden.length ? ` (${hidden.join(", ")})` : " (none given)"}`);
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
  return pidnsMembers(pidns, pid1, proc).length;
}

/** One process `countInPidns` counts, and how: its namespace link is the box's (`ns`); it is unreadable and its parents
 *  lead to the recorded pid 1 (`chain`); unreadable with no pid 1 recorded (`no-pid1`); or unreadable with a chain that
 *  cannot be read to its end (`chain-unread`). With its command, parent and state, for a message that names it. */
export interface PidnsMember {
  pid: number;
  how: "ns" | "chain" | "no-pid1" | "chain-unread";
  comm: string;
  ppid: number;
  state: string;
}

/** What `countInPidns` counts, process by process (see there). */
export function pidnsMembers(pidns: string, pid1?: { pid: number; startTime?: string }, proc = "/proc"): PidnsMember[] {
  const uid = process.getuid?.();
  const members: PidnsMember[] = [];
  const add = (pid: number, how: PidnsMember["how"]) => {
    let comm = "?";
    let ppid = 0;
    let state = "?";
    try {
      const stat = readFileSync(`${proc}/${pid}/stat`, "utf8");
      comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      state = fields[0]!;
      ppid = Number(fields[1]);
    } catch {
      // gone since: counted as read
    }
    members.push({ pid, how, comm, ppid, state });
  };
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    // A zombie runs nothing, whatever its namespace link still says (a box's bwrap waiting on a pid 1 that is slow to
    // reap it): its state is read first, and it is never counted, on any path.
    try {
      const stat = readFileSync(`${proc}/${entry}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      if (state === "Z" || state === "X") continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // gone between the listing and the read
      // Its state cannot be read: not known to be a zombie, so it is judged as below (unknown is never gone).
    }
    try {
      if (readlinkSync(`${proc}/${entry}/ns/pid`) === pidns) add(Number(entry), "ns");
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
        add(Number(entry), "no-pid1");
        continue;
      }
      for (let p = Number(entry), hops = 0; ; hops++) {
        const s = statOf(p, proc);
        if (s === undefined || hops > 4096) {
          add(Number(entry), "chain-unread"); // the chain cannot be read to its end: unknown, so left
          break;
        }
        if (p === pid1.pid) {
          if (s.startTime === pid1.startTime) add(Number(entry), "chain");
          break;
        }
        if (s.parent <= 1) break;
        p = s.parent;
      }
    }
  }
  return members;
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

/** This process's own cgroup v2, as a path under /sys/fs/cgroup; undefined when it cannot be read. */
function selfCgroup(): string | undefined {
  try {
    for (const line of readFileSync("/proc/self/cgroup", "utf8").split("\n")) {
      // cgroup v2's one line: hierarchy id 0, no controller list, then the path.
      const [id, controllers, ...rest] = line.split(":");
      if (id === "0" && controllers === "") return resolve("/sys/fs/cgroup", `.${rest.join(":")}`);
    }
  } catch {
    // unreadable
  }
  return undefined;
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
   *  refused without it, and a reap reads a missing box cgroup as emptied only while this root itself reads. The server
   *  must START inside it (systemd's Delegate=yes): cgroup v2 lets a process move another only within a subtree they
   *  share, so a server moved in later cannot put its boxes there (EACCES), and its start is refused by name. */
  cgroupRoot?: string;
  /** For tests: this process's own cgroup, as a path under /sys/fs/cgroup (default: read from /proc/self/cgroup). */
  selfCgroup?: () => string | undefined;
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
    void exited.then(() => reject(startFailed(stderr())));
  });
}

/** Why a box never started, from what bwrap said: a host that denies it a user namespace with its powers (no namespace
 *  at all, or one without the capabilities to set up its loopback: AppArmor's restriction of unprivileged user
 *  namespaces, which `agentrun-box install` lifts for bwrap) is `bwrap_userns_denied`; anything else, `box_start_failed`. */
function startFailed(said: string): BoxError {
  const denied = /setting up uid map: Permission denied|No permissions to creat(e|ing) new namespace|unprivileged user namespaces|loopback: Failed RTM_NEWADDR: Operation not permitted/i.test(said);
  return new BoxError(
    denied ? "bwrap_userns_denied" : "box_start_failed",
    `bwrap ended before the box started: ${said.trim().slice(0, 300) || "(no output)"}${denied ? " (this host restricts user namespaces: run `agentrun-box install` as root, once)" : ""}`,
  );
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
      const own = (options.selfCgroup ?? selfCgroup)();
      if (own === undefined || !isUnder(own, options.cgroupRoot!)) {
        throw new BoxError(
          "box_refused",
          `this server's own cgroup ${own ?? "(unreadable)"} is not under the delegated root ${options.cgroupRoot}: start the server inside its delegated subtree (systemd's Delegate=yes); a server moved in later cannot put its boxes there (EACCES)`,
        );
      }
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
    // The box's own pipes (info, block, passwd, group): bwrap ending early resets them (EPIPE, ECONNRESET). What that means
    // is said by `ready` and `exited`; an error event there must never end this process.
    for (const fd of [INFO_FD, BLOCK_FD, PASSWD_FD, GROUP_FD]) fds[fd]?.on("error", () => {});
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
        // bwrap is ending: what it said names why (a denied namespace, a mount it could not make).
        await Promise.race([exited, sleep(2000)]);
        const why = startFailed(tail);
        throw new BoxError(why.code, `the box's pid 1 (${pid}) was gone before it could be recorded; ${why.message}`);
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
 *  workspace in (it is removed after); node's install prefix is bound read-only, which under the server's home holds
 *  only while it has no etc/npmrc (checkBoxArgv), and the probe says so otherwise. */
export async function probeBox(options: { scratch: string; bwrap?: string; reapMs?: number; deadlineMs?: number }): Promise<Isolation> {
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
  // The probe's own temporary directory is its data root, and its session lies under it: so a scratch under the server's
  // home (a TMPDIR there) is lent like a run's, and only that directory is hidden, never the rest of the scratch (which
  // may hold node or the kernel's own checkout, both bound read-only).
  const box = bwrapBox({ bwrap, reapMs: options.reapMs ?? 5000, hidden: [dir] });
  try {
    const socket = join(dir, "model.sock");
    write(socket, "");
    const spec: BoxSpec = {
      session: join(dir, "session"),
      workspace: join(dir, "session", "work"),
      homes: {},
      readOnly: [dirname(dirname(process.execPath)), BOX_FORWARD],
      modelSocket: socket,
      modelPort: 8123,
      env: { PATH: "/usr/bin:/bin" },
    };
    mkdirSync(spec.workspace, { recursive: true });
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
    // One deadline from the spawn (start spawned before it returned), over the start and the run alike: a box that never
    // reports its pid 1 (a bind of a source on a filesystem that does not answer) or never ends is killed at it, this
    // box only (its own handle: the spawned bwrap, and its pid 1 once recorded and still the same process), and the probe
    // fails closed.
    const deadlineMs = options.deadlineMs ?? 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolveExpired) => {
      timer = setTimeout(() => {
        boxed.kill();
        resolveExpired("expired");
      }, deadlineMs);
    });
    const timedOut = async (): Promise<Isolation> => {
      await Promise.race([boxed.exited, sleep(2000)]);
      const said = boxed.stderrTail().trim().slice(0, 200);
      return { mode: "unavailable", error: "box_probe_timeout", detail: `the probe's box did not finish within ${deadlineMs} ms of its spawn and was killed${said ? `; bwrap said: ${said}` : ""}` };
    };
    try {
      if ((await Promise.race([boxed.ready, expired])) === "expired") return await timedOut();
      if ((await Promise.race([boxed.exited, expired])) === "expired") return await timedOut();
    } catch (error) {
      return { mode: "unavailable", error: error instanceof BoxError ? error.code : "box_probe_failed", detail: String((error as Error)?.message ?? error) };
    } finally {
      clearTimeout(timer);
    }
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
      !reaped.empty
        ? `the reap left ${reaped.left} process(es) (by ${reaped.by}${reaped.by === "pidns" ? `: ${pidnsMembers(boxed.record.pidns!, { pid: boxed.record.pid!, startTime: boxed.record.startTime }).map((m) => `pid ${m.pid} ${m.comm} ppid ${m.ppid} state ${m.state} via ${m.how}`).join("; ") || "none left by the time they were named"}` : ""})`
        : "",
    ].filter(Boolean);
    if (wrong.length) return { mode: "unavailable", error: "box_probe_failed", detail: `${wrong.join("; ")}${boxed.stderrTail() ? `; bwrap said: ${boxed.stderrTail().trim().slice(0, 200)}` : ""}` };
    return { mode: "bwrap", cgroup: false };
  } finally {
    listener.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
