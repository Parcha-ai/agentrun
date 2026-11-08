// Attach: a run's Workspace reached inside a computer (module D, the computer mount). The contract, as agreed:
//
// 1. The field is ComputerSpec.mount, one of:
//    - { kind: "bind", path: <absolute run folder on this host> }: the local Docker computer only; mode 1 refuses a
//      remote computer;
//    - { kind: "archil", disk, region, folder: "agents/<a>/runs/<r>/work", token }.
//    Every computer mounts at /workspace, the one path (HOME stays /work). An archil mount is always EXCLUSIVE. The
//    epoch comes from the computer's agentrun.run and agentrun.epoch labels, not from the mount.
// 2. THE TOKEN: D holds it and passes it only to the root helper, on fd 0. Never in argv, env, labels, a read-back or
//    an error. It is used once at mount, or at revoke, and then dropped.
// 3. USERS: computerd runs every program with no_new_privs and an empty capability set, so nothing inside computerd
//    can elevate. The computer's user for computerd is agentrun-tool, uid 2510, with NO sudo at all. D runs netlock,
//    mount, revoke and checkin as ROOT through the provider's own exec (as it starts init), never through computerd.
// 4. THE PER-CALL SYNC (rule of 11-08). D syncs, coalesced, before answering, after every call that can change the
//    folder:
//    - files.write, move, remove and mkdir;
//    - tar.push;
//    - exec.run;
//    - process.write and process.signal, and when a process is seen ended.
//    Coalesced means: await the sync in flight, then one more, shared by the waiters. A failed sync fails the call in
//    words. Reads (a bash_output read included) do not sync.
//    HOW: the helper gets one more verb, `serve`, started as root at mount. It stays resident, holds NO token, and
//    answers only "sync" on a unix socket (/run/agentrun, dir 0750 root:2510, socket 0660), returning sync's exit code.
//    D's wrapper calls it through computerd as 2510. That costs about one sync (69 ms measured live, one sample)
//    instead of a vendor exec round trip (estimated 200-400 ms) per call. A tool could also call the socket, which
//    only triggers a coalesced sync, which is harmless.
// 5. RELEASE AND TAKEOVER: checkin after a final sync at release. Takeover = destroy every other computer of the run
//    with a lower epoch FIRST (a failed destroy revokes nothing), then revoke (mount --force), then mount. Measured
//    live: a forced-off exclusive client's later writes still return success and are lost. That is the fence.
// 6. THE READ-BACK that attach expects: the computer ref, plus fuse.archil in /proc/self/mounts with source
//    <disk>:/<folder>, mounted at /workspace, exclusive, under this run's epoch.
// 7. ONCE ATTACHED: D exposes the computer's files, exec and process calls as computerd calls, and C's attached
//    Workspace delegates to them, so tools never know where they run.
// 8. THE HANDOFF to D: from #1845 (kept as reference): the helper (verbs, exit codes 0/1/2/3/4, the hidepid=2 gate
//    with a root remount first), the Dockerfile, the image builds, and the helper's tests and fake.
//
// The lead's notes (approved 11-08):
// 1. The per-call sync is for archil mounts only; a bind mount syncs nothing (the local disk is the server's).
// 2. The resident `serve` verb reads ONE fixed request byte and takes no arguments, holds no token, answers only
//    sync's exit code, coalesces, and exits when the mount is revoked or checked in. A test pins that any other input
//    is refused and nothing is executed. The socket and dir permissions are as written.
// 3. Pin archil 0.10.1 (the live-checked version) by sha256, not 0.10.0.
// 4. Takeover: destroy every lower-epoch computer first, then revoke, then mount; a failed destroy revokes nothing and
//    the attach fails in words.
//
// How C meets it here. A Workspace gives its MountSpec (`mountSpec()`): the caller puts it in ComputerSpec.mount, D
// mounts it, and `attach(computer)` checks D's read-back against it before it hands back the ATTACHED Workspace. That
// one delegates its file calls and exec to the computer's computerd client (D's ComputerClient), each relative path
// turned into /workspace/<path>, and passes the computer's process calls through (`process`, start's cwd and log taken
// relative to the run's folder): the background tools call those, through the Workspace. A Workspace with no computer
// refuses every process call with WorkspaceError REFUSED, cause NO_COMPUTER ("no-computer"); the words a person reads
// are the background tool's. Every computerd and mount type here is D's (@parcha/agentrun-computer), imported as a type,
// never copied; nothing of D runs here. What C needs to run of D (the read-back a mount gives, readBackOf; each
// provider's mounts) is passed in, and the cutover passes D's own.
//
// In the computer, the mount is the boundary: a path is still checked by the relative-path rule (no absolute path, no
// "..", no empty segment), and a read may follow a link inside /workspace, as the computer's own programs do; a call that
// changes the folder refuses a link on its way (ESCAPE) before it changes anything, as the local backend does. grep is
// not a computerd call: it runs through the Workspace the computer mounts (its folder, or the disk's own search),
// which is current because D syncs after every call that changes the folder.
//
// Durable on return, with a bind (lead, 11-08): a bind mount syncs nothing in the computer, so after each delegated
// file call that changes the folder (write, append, mkdir, remove) the local backend fsyncs the target and every
// folder from its own up to the root, on the host; a write's temporary file is synced before the move. A file the host
// cannot open (the computer's own private file, under another account) is synced by the computer itself, as its owner;
// if neither can, the call fails in words. exec's own writes are not covered, the same as with no computer.
import { randomBytes } from "node:crypto";
import type {
  ComputerClient, DaemonMethod, DaemonMethods, Empty, FileStat, MountReadBack, MountSpec, ProcessExit, ProcessListParams, ProcessListResult,
  ProcessReadParams, ProcessReadResult, ProcessSignalParams, ProcessSignalResult, ProcessStartParams, ProcessStartResult, ProcessWaitParams,
  ProcessWriteParams, Result, WORKSPACE,
} from "@parcha/agentrun-computer";
import { relativeSegments } from "./paths.js";
import {
  type Entry, type ExecOptions, type ExecResult, type GrepOptions, type GrepResult, READ_MAX, type Workspace, WorkspaceError,
  type WorkspaceErrorCode,
} from "./workspace.js";

/** Where every computer mounts a run's folder: D's WORKSPACE, checked against its type, so a change there fails here. */
const MOUNT_AT: typeof WORKSPACE = "/workspace";

/** What attach runs of D, passed in (the cutover passes D's own): the read-back a mount made as `spec` asks gives. */
export type MountCheck = { readonly readBackOf: (spec: MountSpec, epoch?: number) => MountReadBack };

/** A computer as attach takes it: its ref, its computerd client, and D's read-back of what it mounts at /workspace. */
export interface AttachableComputer {
  readonly id: string;
  readonly client: ComputerClient;
  readBack(): Promise<Result<MountReadBack>>;
}

/** A computer's background processes, computerd's process calls: what the background tools call, through the
 *  Workspace. With a computer, start's `cwd` and `log` are taken relative to the run's folder. */
export interface Processes {
  start(params: ProcessStartParams): Promise<Result<ProcessStartResult>>;
  read(params: ProcessReadParams): Promise<Result<ProcessReadResult>>;
  write(params: ProcessWriteParams): Promise<Result<Empty>>;
  signal(params: ProcessSignalParams): Promise<Result<ProcessSignalResult>>;
  wait(params: ProcessWaitParams): Promise<Result<ProcessExit>>;
  list(params: ProcessListParams): Promise<Result<ProcessListResult>>;
}

/** The cause of the REFUSED every background call gets on a Workspace with no computer. */
export const NO_COMPUTER = "no-computer";
const refuseBackground = async (): Promise<never> => {
  throw new WorkspaceError("REFUSED", "this workspace has no computer, and background programs run on one", { cause: NO_COMPUTER });
};
/** The background surface of a Workspace with no computer: every call is REFUSED, cause NO_COMPUTER. */
export const noProcesses: Processes = {
  start: refuseBackground, read: refuseBackground, write: refuseBackground, signal: refuseBackground, wait: refuseBackground, list: refuseBackground,
};

/** The most bytes one computerd read or write call moves (its MAX_CHUNK_BYTES). */
export const COMPUTER_CHUNK = 512 * 1024;
/** How many times a read of more than one chunk starts again when the file changed under it. */
const READ_ATTEMPTS = 3;
/** How long the computer's own sync of a file the host cannot open may take. */
const SYNC_TIMEOUT_MS = 60_000;

const CODES: Record<string, WorkspaceErrorCode> = {
  not_found: "NOT_FOUND", exists: "EXISTS", limit: "TOO_LARGE", timeout: "TIMEOUT",
  invalid: "REFUSED", denied: "REFUSED", unsupported: "REFUSED", is_dir: "REFUSED", not_dir: "REFUSED",
};

/** A computer call's value, or its error as a WorkspaceError (one D did not name is UNAVAILABLE). */
async function value<T>(call: Promise<Result<T>>, path: string): Promise<T> {
  const result = await call;
  if (result.ok) return result.value;
  throw new WorkspaceError(CODES[result.error.code] ?? "UNAVAILABLE", `${JSON.stringify(path === "" ? "." : path)}: ${result.error.message}`, { path });
}

const bytesOf = (data: Uint8Array | string): Uint8Array => (typeof data === "string" ? Buffer.from(data, "utf8") : data);
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const chunks = (bytes: Uint8Array): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += COMPUTER_CHUNK) out.push(bytes.subarray(at, at + COMPUTER_CHUNK));
  return out.length === 0 ? [bytes] : out;
};

/**
 * The attached Workspace: `base` (the run's folder, as the computer mounts it) reached inside `computer`. File calls
 * and exec go to its computerd client at /workspace/<path>; grep goes to `base`; `process` is the computer's.
 * attach() checks the mount before it makes one of these. `synced(path)`, when given, runs after each file call that
 * changed `path` (write, append, mkdir, remove): a bind mount's backend makes the change durable on the host there,
 * since nothing in the computer syncs a bind. With "file" it syncs only that file's bytes (a write's temporary file,
 * before the move). When it answers false, the host could not open the entry (another account's private file, as
 * the computer's own can be): the computer then syncs it itself, as its owner (`sync <path>`, exec.run), and a call
 * whose change cannot be made durable either way fails in words, never silently.
 */
export function attachedWorkspace(base: Workspace, computer: AttachableComputer, options: { readonly synced?: (path: string, only?: "file") => Promise<boolean> } = {}): Workspace {
  const call = <M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"]): Promise<Result<DaemonMethods[M]["result"]>> => computer.client.call(method, params);
  const synced = async (rel: string, only?: "file"): Promise<void> => {
    if (options.synced === undefined || (await options.synced(rel, only))) return;
    const ran = await call("exec.run", { argv: ["sync", `${MOUNT_AT}/${rel}`], timeoutMs: SYNC_TIMEOUT_MS });
    if (!ran.ok || ran.value.exitCode !== 0) {
      const why = ran.ok ? `sync exited ${ran.value.timedOut ? "at its deadline" : ran.value.exitCode}` : ran.error.message;
      throw new WorkspaceError("UNAVAILABLE", `${JSON.stringify(rel)} could not be made durable: this host cannot open it, and the computer's own sync failed (${why})`, { path: rel });
    }
  };
  const at = (path: string): { rel: string; abs: string; segments: string[] } => {
    const segments = relativeSegments(path);
    const rel = segments.join("/");
    return { rel, abs: rel === "" ? MOUNT_AT : `${MOUNT_AT}/${rel}`, segments };
  };
  const below = (path: string, what: string): { rel: string; abs: string; segments: string[] } => {
    const where = at(path);
    if (where.segments.length === 0) throw new WorkspaceError("REFUSED", `the workspace's root is a directory, not ${what}`, { path: "" });
    return where;
  };
  /** What is at `abs`, never following a link there; undefined when nothing is. */
  const statOf = async (abs: string, rel: string): Promise<FileStat | undefined> => {
    const result = await call("files.stat", { path: abs, follow: false });
    if (result.ok) return result.value;
    if (result.error.code === "not_found") return undefined;
    return value(Promise.resolve(result), rel);
  };
  const noLink = (stat: FileStat | undefined, rel: string): void => {
    if (stat?.type === "symlink") throw new WorkspaceError("ESCAPE", `${JSON.stringify(rel)} is a symbolic link, and a workspace follows none`, { path: rel });
  };
  /** Each folder on the way to the first `count` segments, in the computer, is not a link (ESCAPE otherwise): a call
   *  that changes the folder is refused before it changes anything, as a bind's host sync would refuse it after. A
   *  folder not there yet ends the walk (the call makes it). Reads follow links inside the computer, its mount the
   *  boundary. */
  const noLinkOnTheWay = async (segments: readonly string[], count: number, rel: string): Promise<void> => {
    for (let i = 1; i <= count; i++) {
      const part = segments.slice(0, i).join("/");
      const stat = await statOf(`${MOUNT_AT}/${part}`, rel);
      if (stat === undefined) return;
      if (stat.type === "symlink") throw new WorkspaceError("ESCAPE", `${JSON.stringify(part)} is a symbolic link, and a workspace follows none`, { path: rel });
      if (stat.type !== "dir") return;
    }
  };

  const processes: Processes = {
    start: async (params) => {
      const log = params.log === undefined ? {} : { log: below(params.log, "a log file").abs };
      return call("process.start", { ...params, cwd: at(params.cwd ?? "").abs, ...log });
    },
    read: (params) => call("process.read", params),
    write: (params) => call("process.write", params),
    signal: (params) => call("process.signal", params),
    wait: (params) => call("process.wait", params),
    list: (params) => call("process.list", params),
  };

  return {
    process: processes,

    async read(path, range) {
      const { rel, abs } = below(path, "a file");
      const offset = range?.offset ?? 0;
      const length = range?.length;
      if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) {
        throw new WorkspaceError("REFUSED", "a read's offset and length are whole numbers, 0 or more", { path: rel });
      }
      if (length !== undefined && length > READ_MAX) throw new WorkspaceError("TOO_LARGE", `a read returns at most ${READ_MAX} bytes`, { path: rel });
      // One computerd read is one version of the file. A read of more chunks than one checks the file's size and time
      // before and after, and starts again when a write replaced it in between, so it never joins two versions. The
      // limit: computerd's stat has no inode or ctime, so a replacement of the same size within the same millisecond
      // of mtime goes unseen.
      for (let attempt = 1; ; attempt++) {
        const before = await statOf(abs, rel);
        noLink(before, rel);
        // What is there is checked before any chunk, so a read of no bytes still says a missing path or a folder.
        if (before === undefined) throw new WorkspaceError("NOT_FOUND", `${JSON.stringify(rel)} is not there`, { path: rel });
        if (before.type !== "file") throw new WorkspaceError("REFUSED", `${JSON.stringify(rel)} is ${before.type === "dir" ? "a directory" : "not a file"}`, { path: rel });
        const parts: Uint8Array[] = [];
        let got = 0;
        let calls = 0;
        for (let next = offset; ;) {
          const want = length === undefined ? COMPUTER_CHUNK : Math.min(COMPUTER_CHUNK, length - got);
          if (want === 0) break;
          const chunk = await value(call("files.read", { path: abs, offset: next, length: want }), rel);
          calls++;
          if (length === undefined && chunk.size - offset > READ_MAX) throw new WorkspaceError("TOO_LARGE", `${JSON.stringify(rel)} is ${chunk.size} bytes; a read returns at most ${READ_MAX} (read it in ranges)`, { path: rel });
          const data = Buffer.from(chunk.data, "base64");
          parts.push(data);
          got += data.length;
          next += data.length;
          if (chunk.eof || data.length === 0) break;
        }
        if (calls <= 1) return Buffer.concat(parts);
        const after = await statOf(abs, rel);
        if (after !== undefined && before !== undefined && after.size === before.size && after.mtimeMs === before.mtimeMs) return Buffer.concat(parts);
        if (attempt === READ_ATTEMPTS) throw new WorkspaceError("UNAVAILABLE", `${JSON.stringify(rel)} kept changing while it was read (${READ_ATTEMPTS} tries)`, { path: rel });
      }
    },

    async write(path, data) {
      const { rel, abs, segments } = below(path, "a file");
      const bytes = bytesOf(data);
      await noLinkOnTheWay(segments, segments.length - 1, rel);
      const existing = await statOf(abs, rel);
      noLink(existing, rel);
      if (existing !== undefined && existing.type !== "file") throw new WorkspaceError("REFUSED", `${JSON.stringify(rel)} is not a file`, { path: rel });
      // computerd replaces a file in place: the bytes go to a temporary file beside it, which a move puts in its place.
      // Replacing a file, the temporary file is its owner's alone (0600), readable and writable, while every chunk goes
      // in and while a bind syncs its bytes on the host: a private file's new bytes are never readable by others on the
      // way, a read-only file takes every chunk, and a write-only one can still be synced. Then a write of no bytes at
      // its end sets the target's mode (computerd opens, sets the mode, then writes), and the move puts it in place, so
      // the name never points at bytes a crash could lose.
      const tempRel = [...segments.slice(0, -1), `.workspace-${randomBytes(8).toString("hex")}.tmp`].join("/");
      const temp = `${MOUNT_AT}/${tempRel}`;
      const mode = existing === undefined ? undefined : existing.mode & 0o777;
      try {
        let written = 0;
        for (const [i, part] of chunks(bytes).entries()) {
          await value(i === 0
            ? call("files.write", { path: temp, data: base64(part), parents: true, ...(mode === undefined ? {} : { mode: 0o600 }) })
            : call("files.write", { path: temp, data: base64(part), append: true }), rel);
          written += part.length;
        }
        await synced(tempRel, "file");
        if (mode !== undefined && mode !== 0o600) await value(call("files.write", { path: temp, data: "", offset: written, mode }), rel);
        await value(call("files.move", { from: temp, to: abs, overwrite: true }), rel);
      } catch (error) {
        await call("files.remove", { path: temp }).catch(() => undefined);
        throw error;
      }
      await synced(rel);
    },

    async append(path, data) {
      const { rel, abs, segments } = below(path, "a file");
      await noLinkOnTheWay(segments, segments.length - 1, rel);
      noLink(await statOf(abs, rel), rel);
      for (const part of chunks(bytesOf(data))) await value(call("files.write", { path: abs, data: base64(part), append: true, parents: true }), rel);
      await synced(rel);
    },

    async list(dir) {
      const { rel, abs } = at(dir);
      const entries: Entry[] = [];
      for (let offset = 0; ;) {
        const page = await value(call("files.list", { path: abs, depth: 1, offset }), rel);
        for (const entry of page.entries) {
          const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
          if (entry.type === "file") entries.push({ name, kind: "file", size: entry.size });
          else if (entry.type === "dir") entries.push({ name, kind: "dir", size: 0 });
        }
        if (!page.truncated || page.entries.length === 0) break;
        offset += page.entries.length;
      }
      return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    async mkdir(dir) {
      const { rel, abs, segments } = at(dir);
      if (segments.length === 0) return;
      await noLinkOnTheWay(segments, segments.length, rel);
      await value(call("files.mkdir", { path: abs, parents: true }), rel);
      await synced(rel);
    },

    grep(pattern: string, options?: GrepOptions): Promise<GrepResult> {
      return base.grep(pattern, options);
    },

    async remove(path, options = {}) {
      const where = at(path);
      if (where.segments.length === 0) throw new WorkspaceError("REFUSED", "the workspace's root is never removed", { path: "" });
      await noLinkOnTheWay(where.segments, where.segments.length - 1, where.rel);
      const existing = await statOf(where.abs, where.rel);
      if (existing === undefined) {
        if (options.force) return;
        throw new WorkspaceError("NOT_FOUND", `${JSON.stringify(where.rel)} is not there`, { path: where.rel });
      }
      noLink(existing, where.rel);
      await value(call("files.remove", { path: where.abs, ...(options.recursive ? { recursive: true } : {}) }), where.rel);
      await synced(where.rel);
    },

    async exec(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
      if (options.stdin !== undefined) throw new WorkspaceError("REFUSED", "exec with stdin runs on the run's folder, not in a computer: computerd's exec.run takes no stdin");
      const { abs, rel } = at(options.cwd ?? "");
      const ran = await value(call("exec.run", {
        argv: [...argv], cwd: abs, env: { ...options.env }, timeoutMs: options.timeoutMs, ...(options.maxOutput === undefined ? {} : { maxOutput: options.maxOutput }),
      }), rel);
      const stdout = Buffer.from(ran.stdout, "base64");
      const stderr = Buffer.from(ran.stderr, "base64");
      // exec.run answers once, at the end: each stream goes to onOutput once, whole.
      if (options.onOutput) {
        for (const [stream, data] of [["stdout", stdout], ["stderr", stderr]] as const) {
          try { options.onOutput({ stream, data }); } catch { /* the caller's callback; its error is not the call's */ }
        }
      }
      return { stdout, stderr: stderr.toString("utf8"), code: ran.exitCode, timedOut: ran.timedOut, truncated: ran.truncated };
    },

    mountSpec: () => base.mountSpec(),

    async attach() {
      throw new WorkspaceError("REFUSED", "this workspace is already attached to a computer");
    },
  };
}

/** A read-back in words, never with the token (D's read-backs hold none). */
const shown = (back: MountReadBack): string =>
  "other" in back ? back.other : back.kind === "bind" ? `a bind of ${back.path}` : `${back.disk}:/${back.folder} in ${back.region}`;
const keyOf = (back: MountReadBack): string => ("other" in back ? `other ${back.other}` : `${back.kind} ${shown(back)}`);

/** `computer`'s read-back checked against the one a mount made as `spec` asks gives (`check.readBackOf`, D's): anything
 *  else, a mount D never makes ("other") included, is REFUSED in words, never with the token.
 *  TODO(D6): D6 adds exclusive and epoch to the disk's read-back; check them here then. */
export async function checkReadBack(computer: AttachableComputer, spec: MountSpec, check: MountCheck): Promise<void> {
  const read = await computer.readBack();
  if (!read.ok) throw new WorkspaceError("UNAVAILABLE", `the computer ${computer.id} did not say what it mounts at ${MOUNT_AT}: ${read.error.message}`);
  // The read-back's own epoch: D's Archil read-back carries the computer's claim epoch. The claim-epoch fence (this
  // run's epoch against the computer's) lands with the cutover.
  const want = check.readBackOf(spec, "kind" in read.value && read.value.kind === "archil" ? read.value.epoch : undefined);
  if (keyOf(read.value) !== keyOf(want)) {
    throw new WorkspaceError("REFUSED", `the computer ${computer.id} does not hold this run's folder at ${MOUNT_AT}: it mounts ${shown(read.value)}, not ${shown(want)}`);
  }
}
