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
// one delegates its file calls and exec to the computer, each relative path turned into /workspace/<path>, and
// passes the computer's process calls through (`process`): the background tools call those, through the Workspace.
// A Workspace with no computer refuses every process call in words (BACKGROUND_REFUSAL). C depends only on the
// `Computer` interface below; D implements it over computerd.
//
// In the computer, the mount is the boundary: a path is still checked by the relative-path rule (no absolute path, no
// "..", no empty segment), but a link inside /workspace is the computer's to follow, as its own programs do. grep is
// not a computerd call: it runs through the Workspace the computer mounts (its folder, or the disk's own search),
// which is current because D syncs after every call that changes the folder.
//
// Durable on return, with a bind (lead, 11-08): a bind mount syncs nothing in the computer, so after each delegated
// file call that changes the folder (write, append, mkdir, remove) the local backend fsyncs the target and every
// folder from its own up to the root, on the host. exec's own writes are not covered, the same as with no computer.
import { randomBytes } from "node:crypto";
import { relativeSegments } from "./paths.js";
import {
  type Entry, type ExecOptions, type ExecResult, type GrepOptions, type GrepResult, READ_MAX, type Workspace, WorkspaceError,
  type WorkspaceErrorCode,
} from "./workspace.js";

/** Where every computer mounts a run's folder. */
export const MOUNT_AT = "/workspace";

/** What a computer mounts at /workspace: the run's folder on this host (the local Docker computer only), or the
 *  run's folder on the owner's disk. The token goes to D's root helper on fd 0 and nowhere else. */
export type MountSpec =
  | { readonly kind: "bind"; readonly path: string }
  | { readonly kind: "archil"; readonly disk: string; readonly region: string; readonly folder: string; readonly token: string };

/** What D reads back of a computer's /workspace mount. An archil read-back is fuse.archil with source <disk>:/<folder>,
 *  exclusive, under the run's epoch (from the computer's labels); it never holds the token. */
export type MountReadBack =
  | { readonly kind: "bind"; readonly at: string; readonly path: string }
  | { readonly kind: "archil"; readonly at: string; readonly source: string; readonly exclusive: boolean; readonly epoch: number };

/** A computer call's error, as D reports computerd's (and its provider's) refusals. */
export type ComputerErrorCode =
  | "gone" | "refused" | "timeout" | "aborted" | "not_found" | "invalid" | "unsupported" | "denied" | "limit" | "exists"
  | "not_dir" | "is_dir" | (string & {});
/** An expected outcome of a computer call: a value, or an error in words (D's Result). */
export type ComputerResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: ComputerErrorCode; readonly message: string } };

export type ComputerFileType = "file" | "dir" | "symlink" | "other";
export type ComputerStat = { readonly type: ComputerFileType; readonly size: number; readonly mode: number };
export type ProcessStream = "stdout" | "stderr" | "pty";
export type ProcessSignal = "TERM" | "INT" | "KILL" | "HUP";
export type ProcessExit = { readonly running: boolean; readonly exitCode: number | null; readonly signal: string | null };
export type ProcessInfo = ProcessExit & {
  readonly id: string; readonly pid: number; readonly argv: readonly string[]; readonly pty: boolean; readonly startedAt: number; readonly endedAt: number | null;
};

/** A computer's background processes (computerd's process.*): what the background tools call, through the Workspace.
 *  Paths are the computer's own here, apart from start's `cwd`, which the attached Workspace takes relative to the
 *  run's folder. */
export interface Processes {
  start(params: { readonly argv: readonly string[]; readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly pty?: { readonly cols: number; readonly rows: number }; readonly stdin?: boolean }): Promise<ComputerResult<{ readonly id: string; readonly pid: number }>>;
  read(params: { readonly id: string; readonly stream: ProcessStream; readonly offset: number; readonly maxBytes?: number; readonly waitMs?: number }): Promise<ComputerResult<{ readonly data: Uint8Array; readonly nextOffset: number; readonly dropped: number; readonly exited: boolean }>>;
  write(params: { readonly id: string; readonly data?: Uint8Array; readonly close?: boolean }): Promise<ComputerResult<Record<string, never>>>;
  signal(params: { readonly id: string; readonly signal: ProcessSignal }): Promise<ComputerResult<{ readonly note?: string }>>;
  wait(params: { readonly id: string; readonly timeoutMs: number }): Promise<ComputerResult<ProcessExit>>;
  list(params: { readonly from?: number }): Promise<ComputerResult<{ readonly processes: readonly ProcessInfo[]; readonly truncated: boolean; readonly next: number }>>;
}

/**
 * What module D's attached computer offers C: its files, exec and processes as computerd calls (absolute paths in the
 * computer, bytes as Uint8Array), and the read-back of its /workspace mount. D implements it; C depends on nothing else.
 */
export interface Computer {
  /** The computer's ref (its provider's id for it). */
  readonly id: string;
  readonly files: {
    /** At most `length` bytes from `offset` (D's chunk cap applies); `eof` once the file's end is in. */
    read(params: { readonly path: string; readonly offset?: number; readonly length?: number }): Promise<ComputerResult<{ readonly data: Uint8Array; readonly eof: boolean; readonly size: number }>>;
    /** The file replaced by `data` (in place), or written at `offset`; parents made with `parents`. */
    write(params: { readonly path: string; readonly data: Uint8Array; readonly offset?: number; readonly mode?: number; readonly parents?: boolean }): Promise<ComputerResult<{ readonly size: number }>>;
    /** `data` added at the end; the file, and with `parents` its folders, made when absent. */
    append(params: { readonly path: string; readonly data: Uint8Array; readonly parents?: boolean }): Promise<ComputerResult<{ readonly size: number }>>;
    /** One level of a directory, a page from `offset`; `truncated` when more follow. */
    list(params: { readonly path: string; readonly offset?: number }): Promise<ComputerResult<{ readonly entries: readonly (ComputerStat & { readonly path: string })[]; readonly truncated: boolean }>>;
    mkdir(params: { readonly path: string; readonly parents?: boolean }): Promise<ComputerResult<Record<string, never>>>;
    move(params: { readonly from: string; readonly to: string; readonly overwrite?: boolean }): Promise<ComputerResult<Record<string, never>>>;
    /** A link is removed, never followed. */
    remove(params: { readonly path: string; readonly recursive?: boolean }): Promise<ComputerResult<Record<string, never>>>;
    stat(params: { readonly path: string; readonly follow?: boolean }): Promise<ComputerResult<ComputerStat>>;
  };
  readonly exec: {
    /** argv, never a shell line; env is added over the computer's minimal default (PATH, HOME, USER, LOGNAME). */
    run(params: { readonly argv: readonly string[]; readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly maxOutput?: number }): Promise<ComputerResult<{ readonly exitCode: number | null; readonly stdout: Uint8Array; readonly stderr: Uint8Array; readonly timedOut: boolean; readonly truncated: boolean }>>;
  };
  readonly process: Processes;
  /** What is mounted at /workspace, as D reads it back. */
  readBack(): Promise<ComputerResult<MountReadBack>>;
}

/** What every background call answers on a Workspace with no computer. */
export const BACKGROUND_REFUSAL = "Background programs need a computer: run this agent with place sandbox (Docker in Mode 1, or a remote computer in Mode 2).";

const refuseBackground = async (): Promise<never> => { throw new WorkspaceError("REFUSED", BACKGROUND_REFUSAL); };
/** The background surface of a Workspace with no computer: every call is REFUSED, in BACKGROUND_REFUSAL's words. */
export const noProcesses: Processes = {
  start: refuseBackground, read: refuseBackground, write: refuseBackground, signal: refuseBackground, wait: refuseBackground, list: refuseBackground,
};

/** The most bytes one computer read or write call moves (computerd's chunk). */
export const COMPUTER_CHUNK = 512 * 1024;

const CODES: Record<string, WorkspaceErrorCode> = {
  not_found: "NOT_FOUND", exists: "EXISTS", limit: "TOO_LARGE", timeout: "TIMEOUT",
  invalid: "REFUSED", denied: "REFUSED", unsupported: "REFUSED", is_dir: "REFUSED", not_dir: "REFUSED",
};

/** A computer call's value, or its error as a WorkspaceError (one D did not name is UNAVAILABLE). */
async function value<T>(call: Promise<ComputerResult<T>>, path: string): Promise<T> {
  const result = await call;
  if (result.ok) return result.value;
  throw new WorkspaceError(CODES[result.error.code] ?? "UNAVAILABLE", `${JSON.stringify(path === "" ? "." : path)}: ${result.error.message}`, { path });
}

const bytesOf = (data: Uint8Array | string): Uint8Array => (typeof data === "string" ? Buffer.from(data, "utf8") : data);
const chunks = (bytes: Uint8Array): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += COMPUTER_CHUNK) out.push(bytes.subarray(at, at + COMPUTER_CHUNK));
  return out.length === 0 ? [bytes] : out;
};

/**
 * The attached Workspace: `base` (the run's folder, as the computer mounts it) reached inside `computer`. File calls
 * and exec go to the computer at /workspace/<path>; grep goes to `base`; `process` is the computer's, with start's
 * cwd taken relative to the run's folder. attach() checks the mount before it makes one of these. `synced(path)`, when
 * given, runs after each file call that changed `path` (write, append, mkdir, remove): a bind mount's backend makes the
 * change durable on the host there, since nothing in the computer syncs a bind.
 */
export function attachedWorkspace(base: Workspace, computer: Computer, options: { readonly synced?: (path: string) => Promise<void> } = {}): Workspace {
  const synced = options.synced ?? (async () => undefined);
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
  const statOf = async (abs: string, rel: string): Promise<{ type: ComputerFileType; mode: number } | undefined> => {
    const result = await computer.files.stat({ path: abs, follow: false });
    if (result.ok) return result.value;
    if (result.error.code === "not_found") return undefined;
    return value(Promise.resolve(result), rel);
  };
  const noLink = (stat: { type: ComputerFileType } | undefined, rel: string): void => {
    if (stat?.type === "symlink") throw new WorkspaceError("ESCAPE", `${JSON.stringify(rel)} is a symbolic link, and a workspace follows none`, { path: rel });
  };

  const processes: Processes = {
    ...computer.process,
    start: async (params) => {
      const { abs } = at(params.cwd ?? "");
      return computer.process.start({ ...params, cwd: abs });
    },
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
      noLink(await statOf(abs, rel), rel);
      const parts: Uint8Array[] = [];
      let got = 0;
      for (let next = offset; ;) {
        const want = length === undefined ? COMPUTER_CHUNK : Math.min(COMPUTER_CHUNK, length - got);
        if (want === 0) break;
        const chunk = await value(computer.files.read({ path: abs, offset: next, length: want }), rel);
        if (length === undefined && chunk.size - offset > READ_MAX) throw new WorkspaceError("TOO_LARGE", `${JSON.stringify(rel)} is ${chunk.size} bytes; a read returns at most ${READ_MAX} (read it in ranges)`, { path: rel });
        parts.push(chunk.data);
        got += chunk.data.length;
        next += chunk.data.length;
        if (chunk.eof || chunk.data.length === 0) break;
      }
      return Buffer.concat(parts);
    },

    async write(path, data) {
      const { rel, abs, segments } = below(path, "a file");
      const bytes = bytesOf(data);
      const existing = await statOf(abs, rel);
      noLink(existing, rel);
      if (existing !== undefined && existing.type !== "file") throw new WorkspaceError("REFUSED", `${JSON.stringify(rel)} is not a file`, { path: rel });
      // computerd replaces a file in place: the bytes go to a temporary file beside it, which a move puts in its place.
      const temp = `${MOUNT_AT}/${[...segments.slice(0, -1), `.workspace-${randomBytes(8).toString("hex")}.tmp`].join("/")}`;
      try {
        let first = true;
        for (const part of chunks(bytes)) {
          await value(first
            ? computer.files.write({ path: temp, data: part, parents: true, ...(existing === undefined ? {} : { mode: existing.mode & 0o777 }) })
            : computer.files.append({ path: temp, data: part }), rel);
          first = false;
        }
        await value(computer.files.move({ from: temp, to: abs, overwrite: true }), rel);
      } catch (error) {
        await computer.files.remove({ path: temp }).catch(() => undefined);
        throw error;
      }
      await synced(rel);
    },

    async append(path, data) {
      const { rel, abs } = below(path, "a file");
      noLink(await statOf(abs, rel), rel);
      for (const part of chunks(bytesOf(data))) await value(computer.files.append({ path: abs, data: part, parents: true }), rel);
      await synced(rel);
    },

    async list(dir) {
      const { rel, abs } = at(dir);
      const entries: Entry[] = [];
      for (let offset = 0; ;) {
        const page = await value(computer.files.list({ path: abs, offset }), rel);
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
      await value(computer.files.mkdir({ path: abs, parents: true }), rel);
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
      await value(computer.files.remove({ path: where.abs, ...(options.recursive ? { recursive: true } : {}) }), where.rel);
      await synced(where.rel);
    },

    async exec(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
      if (options.stdin !== undefined) throw new WorkspaceError("REFUSED", "exec with stdin runs on the run's folder, not in a computer: computerd's exec.run takes no stdin");
      const { abs, rel } = at(options.cwd ?? "");
      const ran = await value(computer.exec.run({
        argv, cwd: abs, env: options.env, timeoutMs: options.timeoutMs, ...(options.maxOutput === undefined ? {} : { maxOutput: options.maxOutput }),
      }), rel);
      // exec.run answers once, at the end: each stream goes to onOutput once, whole.
      if (options.onOutput) {
        for (const [stream, data] of [["stdout", ran.stdout], ["stderr", ran.stderr]] as const) {
          try { options.onOutput({ stream, data }); } catch { /* the caller's callback; its error is not the call's */ }
        }
      }
      return { stdout: ran.stdout, stderr: Buffer.from(ran.stderr).toString("utf8"), code: ran.exitCode, timedOut: ran.timedOut, truncated: ran.truncated };
    },

    mountSpec: () => base.mountSpec(),

    async attach() {
      throw new WorkspaceError("REFUSED", "this workspace is already attached to a computer");
    },
  };
}

/** `computer`'s read-back checked against `spec`, the mount the Workspace asked for: anything else is REFUSED in words. */
export async function checkMount(computer: Computer, spec: MountSpec): Promise<void> {
  const read = await computer.readBack();
  if (!read.ok) throw new WorkspaceError("UNAVAILABLE", `the computer ${computer.id} did not say what it mounts at ${MOUNT_AT}: ${read.error.message}`);
  const got = read.value;
  const refuse = (why: string): never => { throw new WorkspaceError("REFUSED", `the computer ${computer.id} does not hold this run's folder at ${MOUNT_AT}: ${why}`); };
  if (got.at !== MOUNT_AT) refuse(`its mount is at ${got.at}`);
  if (spec.kind === "bind") {
    if (got.kind !== "bind") refuse(`it mounts ${got.kind}, not a bind of the run's folder`);
    else if (got.path !== spec.path) refuse(`it binds ${got.path}, not ${spec.path}`);
    return;
  }
  if (got.kind !== "archil") return refuse(`it mounts ${got.kind}, not the run's folder on the disk`);
  if (got.source !== `${spec.disk}:/${spec.folder}`) refuse(`its source is ${got.source}, not ${spec.disk}:/${spec.folder}`);
  if (!got.exclusive) refuse("the mount is not exclusive");
}
