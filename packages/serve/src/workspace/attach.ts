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
// are the background tool's. Every computerd type here is D's (@parcha/agentrun-computer), imported, never copied.
//
// In the computer, the mount is the boundary: a path is still checked by the relative-path rule (no absolute path, no
// "..", no empty segment), but a link inside /workspace is the computer's to follow, as its own programs do. grep is
// not a computerd call: it runs through the Workspace the computer mounts (its folder, or the disk's own search),
// which is current because D syncs after every call that changes the folder.
//
// Durable on return, with a bind (lead, 11-08): a bind mount syncs nothing in the computer, so after each delegated
// file call that changes the folder (write, append, mkdir, remove) the local backend fsyncs the target and every
// folder from its own up to the root, on the host; a write's temporary file is synced before the move. exec's own
// writes are not covered, the same as with no computer.
import { randomBytes } from "node:crypto";
import type {
  ComputerClient, DaemonMethod, DaemonMethods, Empty, FileStat, ProcessExit, ProcessListParams, ProcessListResult, ProcessReadParams,
  ProcessReadResult, ProcessSignalParams, ProcessSignalResult, ProcessStartParams, ProcessStartResult, ProcessWaitParams, ProcessWriteParams,
  Result,
} from "@parcha/agentrun-computer";
import { relativeSegments } from "./paths.js";
import {
  type Entry, type ExecOptions, type ExecResult, type GrepOptions, type GrepResult, READ_MAX, type Workspace, WorkspaceError,
  type WorkspaceErrorCode,
} from "./workspace.js";

/** Where every computer mounts a run's folder. */
export const MOUNT_AT = "/workspace";

// MountSpec and MountReadBack are D's (its mount module): these two stand in until that lands, then go.
/** What a computer mounts at /workspace: the run's folder on this host (a local computer only), or the
 *  run's folder on the owner's disk. The token goes to D's root helper on fd 0 and nowhere else. */
export type MountSpec =
  | { readonly kind: "bind"; readonly path: string }
  | { readonly kind: "archil"; readonly disk: string; readonly region: string; readonly folder: string; readonly token: string };
/** What D reads back of a computer's /workspace mount; never the token. */
export type MountReadBack =
  | { readonly kind: "bind"; readonly path: string }
  | { readonly kind: "archil"; readonly disk: string; readonly region: string; readonly folder: string };

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
 * before the move).
 */
export function attachedWorkspace(base: Workspace, computer: AttachableComputer, options: { readonly synced?: (path: string, only?: "file") => Promise<void> } = {}): Workspace {
  const synced = options.synced ?? (async () => undefined);
  const call = <M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"]): Promise<Result<DaemonMethods[M]["result"]>> => computer.client.call(method, params);
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
      // before and after, and starts again when a write replaced it in between, so it never joins two versions.
      for (let attempt = 1; ; attempt++) {
        const before = await statOf(abs, rel);
        noLink(before, rel);
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
      const existing = await statOf(abs, rel);
      noLink(existing, rel);
      if (existing !== undefined && existing.type !== "file") throw new WorkspaceError("REFUSED", `${JSON.stringify(rel)} is not a file`, { path: rel });
      // computerd replaces a file in place: the bytes go to a temporary file beside it, which a move puts in its place.
      // The temporary file stays writable until its last chunk, which also sets the target's mode (a read-only file
      // replaced in many chunks would refuse the next one). On a bind, its bytes are synced before the move, so the
      // name never points at bytes a crash could lose.
      const tempRel = [...segments.slice(0, -1), `.workspace-${randomBytes(8).toString("hex")}.tmp`].join("/");
      const temp = `${MOUNT_AT}/${tempRel}`;
      const mode = existing === undefined ? {} : { mode: existing.mode & 0o777 };
      try {
        const parts = chunks(bytes);
        let written = 0;
        for (const [i, part] of parts.entries()) {
          const last = i === parts.length - 1;
          await value(i === 0
            ? call("files.write", { path: temp, data: base64(part), parents: true, ...(last ? mode : {}) })
            : call("files.write", last && existing !== undefined ? { path: temp, data: base64(part), offset: written, ...mode } : { path: temp, data: base64(part), append: true }), rel);
          written += part.length;
        }
        await synced(tempRel, "file");
        await value(call("files.move", { from: temp, to: abs, overwrite: true }), rel);
      } catch (error) {
        await call("files.remove", { path: temp }).catch(() => undefined);
        throw error;
      }
      await synced(rel);
    },

    async append(path, data) {
      const { rel, abs } = below(path, "a file");
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
      await value(call("files.mkdir", { path: abs, parents: true }), rel);
      await synced(rel);
    },

    grep(pattern: string, options?: GrepOptions): Promise<GrepResult> {
      return base.grep(pattern, options);
    },

    async remove(path, options = {}) {
      const where = at(path);
      if (where.segments.length === 0) throw new WorkspaceError("REFUSED", "the workspace's root is never removed", { path: "" });
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

/** `computer`'s read-back checked against `spec`, the mount the Workspace asked for: anything else is REFUSED in words
 *  (never with the token). */
export async function checkMount(computer: AttachableComputer, spec: MountSpec): Promise<void> {
  const read = await computer.readBack();
  if (!read.ok) throw new WorkspaceError("UNAVAILABLE", `the computer ${computer.id} did not say what it mounts at ${MOUNT_AT}: ${read.error.message}`);
  const got = read.value;
  const refuse = (why: string): never => { throw new WorkspaceError("REFUSED", `the computer ${computer.id} does not hold this run's folder at ${MOUNT_AT}: ${why}`); };
  if (spec.kind === "bind") {
    if (got.kind !== "bind") refuse(`it mounts ${got.kind}, not a bind of the run's folder`);
    else if (got.path !== spec.path) refuse(`it binds ${got.path}, not ${spec.path}`);
    return;
  }
  if (got.kind !== "archil") return refuse(`it mounts ${got.kind}, not the run's folder on the disk`);
  const want = `${spec.disk}:/${spec.folder} in ${spec.region}`;
  if (`${got.disk}:/${got.folder} in ${got.region}` !== want) refuse(`it mounts ${got.disk}:/${got.folder} in ${got.region}, not ${want}`);
}
