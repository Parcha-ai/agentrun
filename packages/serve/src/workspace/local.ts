// LocalWorkspace: a Workspace on a folder of this machine, through node:fs, and exec as a local child process.
//
// Confinement. Every path is checked by paths.ts relativeSegments, then walked from the root one folder at a time, each
// opened with O_DIRECTORY | O_NOFOLLOW and held open: a link anywhere on the way is ESCAPE. On Linux every later name
// resolves inside the folder a handle holds, through /proc/self/fd/<fd>/<name> (openat's effect: node has no openat), so
// a folder swapped for a link after the walk is never followed: the read, write, rename, unlink, readdir, mkdir and
// exec's working directory all go through the handle. The last part is opened with O_NOFOLLOW, or acted on by a call
// that does not follow it (rename, unlink, rmdir), after an lstat refuses a link there. A recursive remove walks the
// tree by handles too, and removes a link it meets, never what it points at.
//
// Elsewhere (macOS: Docker Desktop binds the run's folder, so a box process can swap a folder in it for a link) there
// is no /proc/self/fd, and node has no openat, so later calls resolve the path again. There every open (each folder the
// walk holds, and each file a read, write, append or grep opens) refuses a link anywhere below the root, not only at
// the end (beneath.ts: macOS's O_NOFOLLOW_ANY): a folder swapped for a link before or during the open is ELOOP, so
// ESCAPE, and what the handle holds was reached through real folders of the root's at the open itself. Nothing is
// resolved again after it, so a swap after the open, or one that comes and goes, changes nothing a read returns. A
// call that acts on a name instead (unlink, rmdir, rename, readdir, lstat, mkdir, exec's cwd) checks, just before,
// that its folder's path opens the same way to the folder held: a link swapped in by then is ESCAPE. What remains is
// the gap between that check and the call itself, which only an unlinkat or a fchdir closes. The path-resolving branch
// is chosen by `procFd`, so a test runs it on Linux too.
//
// Durability. write is a temporary file in the same folder (O_EXCL), its bytes, fsync, rename over the name, then fsync
// of the folder. append is O_APPEND, its bytes, fdatasync, and the folder's fsync when it made the file. mkdir fsyncs
// the folder above each one it made; remove fsyncs the folder it removed from. Each returns once that is done. Files
// written are opened read-write, not write-only, so a crash test's fsync shim can copy what each sync made durable.
//
// grep runs in a worker thread (grep-worker.ts), terminated at its deadline: a regex that backtracks without end
// costs that thread, never this one.
//
// A computer reaches this folder as a bind at /workspace (mountSpec, the local Docker computer only); attach checks
// that read-back and hands back the attached Workspace (attach.ts). With no computer, `process` refuses in words.
//
// No locks: two calls on one path race as two processes would (workspace.ts).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, type FileHandle, lstat, mkdir as makeDir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { MountSpec } from "@parcha/agentrun-computer";
import { type AttachableComputer, attachedWorkspace, checkReadBack, type MountCheck, noProcesses } from "./attach.js";
import { openBeneath } from "./beneath.js";
import type { GrepJob } from "./grep-worker.js";
import { relativeSegments } from "./paths.js";
import {
  abortError, EXEC_OUTPUT_MAX, type Entry, type ExecOptions, type ExecResult, GREP_FILE_MAX, GREP_LINE_MAX, GREP_MAX,
  GREP_TIME_MS, type GrepMatch, type GrepOptions, type GrepResult, READ_MAX, type Stat, type Workspace, WorkspaceError,
  type WorkspaceErrorCode,
} from "./workspace.js";

const { O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_RDWR, O_WRONLY } = constants;
const LINUX = process.platform === "linux";
/** How a folder on the way is opened: as a folder, never through a link (a link there fails ENOTDIR or ELOOP). */
const DIR_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
/** After the process it ran exits, how long exec waits for its output pipes to close before it closes them itself (a
 *  process that left the group can hold them). */
const PIPE_GRACE_MS = 500;
/** git's rule for a binary file: a NUL in its first 8000 bytes. */
const BINARY_PROBE = 8000;
const GREP_WORKER = new URL("./grep-worker.js", import.meta.url);

const show = (path: string): string => JSON.stringify(path === "" ? "." : path);
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const escape = (part: string, path: string): WorkspaceError =>
  new WorkspaceError("ESCAPE", `${show(part)} is a symbolic link, and a workspace follows none`, { path });

/** A node:fs failure as a WorkspaceError. */
function failed(error: unknown, path: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const at = { path, cause: error };
  switch (errno(error)) {
    case "ENOENT":
    case "ENOTDIR": return new WorkspaceError("NOT_FOUND", `${show(path)} is not there`, at);
    case "ELOOP": return escape(path, path);
    case "EEXIST": return new WorkspaceError("EXISTS", `${show(path)} is in the way`, at);
    case "EISDIR": return new WorkspaceError("REFUSED", `${show(path)} is a directory`, at);
    case "ENOTEMPTY": return new WorkspaceError("REFUSED", `${show(path)} is a directory that is not empty (remove it with recursive)`, at);
    case "ENXIO": return new WorkspaceError("REFUSED", `${show(path)} is not a file`, at);
    case "ENAMETOOLONG": return new WorkspaceError("REFUSED", `${show(path)} is too long a name`, at);
    case "EACCES":
    case "EPERM": return new WorkspaceError("REFUSED", `${show(path)}: permission denied`, at);
    default: return new WorkspaceError("UNAVAILABLE", `${show(path)}: ${(error as Error)?.message ?? String(error)}`, at);
  }
}

const lstatOrNot = (path: string): Promise<Stats | undefined> =>
  lstat(path).catch((error: unknown) => { if (errno(error) === "ENOENT") return undefined; throw error; });

const bytesOf = (data: Uint8Array | string): Uint8Array => {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return data;
  throw new WorkspaceError("REFUSED", "data is bytes (a Uint8Array) or a string");
};

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type LocalWorkspaceOptions = {
  /** A name below a held folder resolves through /proc/self/fd/<fd> (default: on Linux, where it is there). false takes
   *  the branch every other platform (macOS) takes, which resolves paths again and checks each one (the file's head). */
  readonly procFd?: boolean;
  /** A test's hook: called each time a folder below the root is held, with its path, before anything is done in it:
   *  where another process's swap of that folder for a link would land. */
  readonly onHeld?: (abs: string) => void | Promise<void>;
};

/** How names below the root are reached: the root's real path, whether through /proc/self/fd, and the test's hook. */
type Reach = { readonly root: string; readonly procFd: boolean; readonly onHeld?: (abs: string) => void | Promise<void> };

/** A link swapped in on the way to `path` since it was walked: ESCAPE. */
const swapped = (path: string): WorkspaceError =>
  new WorkspaceError("ESCAPE", `${show(path)} runs through a symbolic link swapped in on the way, and a workspace follows none`, { path });

/** A folder held open. On Linux a name in it resolves through /proc/self/fd/<fd>, inside the folder the handle holds,
 *  never through the folder's path again; elsewhere through its path: opened through no link (open), and each other
 *  act checked first (confirm). */
class Held {
  constructor(readonly handle: FileHandle, readonly abs: string, readonly reach: Reach) {}
  /** The folder's path below the root ("" for the root). */
  get below(): string {
    return this.abs === this.reach.root ? "" : this.abs.slice(this.reach.root.length + 1);
  }
  /** The folder itself, as a path a call (or exec's cwd) can take. */
  get self(): string {
    return this.reach.procFd ? `/proc/self/fd/${this.handle.fd}` : this.abs;
  }
  /** Entry `name` of the folder. */
  at(name: string): string {
    return this.reach.procFd ? `/proc/self/fd/${this.handle.fd}/${name}` : join(this.abs, name);
  }
  /** Entry `name` opened with `flags`. Off /proc/self/fd through no link anywhere below the root (beneath.ts): a link
   *  on the way, a folder swapped for one, fails ELOOP, so what opens is under the root. */
  open(name: string, flags: number, mode?: number): Promise<FileHandle> {
    if (this.reach.procFd) return open(this.at(name), flags, mode);
    return openBeneath(this.reach.root, this.below === "" ? name : `${this.below}/${name}`, flags, mode);
  }
  /** Off /proc/self/fd, that this folder's path still opens, through no link, to the folder held (dev and inode), else
   *  ESCAPE (NOT_FOUND when it is gone): run just before each call that resolves a name in it again. On Linux there is
   *  nothing to check. */
  async confirm(path: string): Promise<void> {
    if (this.reach.procFd) return;
    let there: FileHandle;
    try {
      there = await openBeneath(this.reach.root, this.below, DIR_FLAGS);
    } catch (error) {
      if (errno(error) === "ELOOP") throw swapped(path);
      throw failed(error, path);
    }
    try {
      const [held, now] = await Promise.all([this.handle.stat(), there.stat()]);
      if (now.dev !== held.dev || now.ino !== held.ino) throw swapped(path);
    } finally {
      await there.close();
    }
  }
  /** Makes entry `name`, the file `made` just made by `open`, durable: syncs the folder it was made in. On Linux that is
   *  the folder held. Elsewhere `open` went by the folder's path, which may name another folder under the root by now
   *  (one put in its place), so the folder the path opens now, through no link, is synced, once its `name` is that very
   *  file (dev and inode); else ESCAPE, as for any swap. */
  async syncMade(name: string, made: Stats, path: string): Promise<void> {
    if (this.reach.procFd) return this.handle.sync();
    let parent: FileHandle | undefined;
    let entry: FileHandle | undefined;
    try {
      parent = await openBeneath(this.reach.root, this.below, DIR_FLAGS);
      entry = await openBeneath(this.reach.root, this.below === "" ? name : `${this.below}/${name}`, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const now = await entry.stat();
      if (now.dev !== made.dev || now.ino !== made.ino) throw swapped(path);
      await parent.sync();
    } catch (error) {
      throw errno(error) === "ELOOP" ? swapped(path) : error;
    } finally {
      await entry?.close();
      await parent?.close();
    }
  }
  /** `fn`, its folder confirmed before and after: what it read was read in the folder held. */
  async confirmed<T>(path: string, fn: () => Promise<T>): Promise<T> {
    await this.confirm(path);
    const result = await fn();
    await this.confirm(path);
    return result;
  }
  /** Folder `name` of this one, just opened as `handle` (by `open`), held. The caller still owns the handle (it closes
   *  it, whether this resolves or not). */
  async hold(handle: FileHandle, name: string): Promise<Held> {
    const next = new Held(handle, join(this.abs, name), this.reach);
    await this.reach.onHeld?.(next.abs);
    return next;
  }
}

/** Everything in held folder `dir` removed, folders by handle: a link is removed, never followed. Off /proc/self/fd,
 *  each name is acted on only once its folder is confirmed (Held.confirm), and each folder is entered by Held.open. */
async function emptyTree(dir: Held, path: string): Promise<void> {
  for (const name of await dir.confirmed(path, () => readdir(dir.self))) {
    await dir.confirm(path);
    const stats = await lstatOrNot(dir.at(name));
    if (stats === undefined) continue;
    if (!stats.isDirectory()) {
      // Not a folder (a file, or a link: unlink removes the link itself, never what it points at).
      await dir.confirm(path);
      await unlink(dir.at(name));
      continue;
    }
    let handle: FileHandle;
    try {
      handle = await dir.open(name, DIR_FLAGS);
    } catch (error) {
      if (errno(error) !== "ENOTDIR" && errno(error) !== "ELOOP") throw error;
      await dir.confirm(path);
      await unlink(dir.at(name));
      continue;
    }
    try {
      await emptyTree(await dir.hold(handle, name), path);
    } finally {
      await handle.close();
    }
    await dir.confirm(path);
    await rmdir(dir.at(name));
  }
}

class LocalWorkspace implements Workspace {
  readonly #root: string;
  readonly #options: LocalWorkspaceOptions;
  #reach: Reach | undefined;

  constructor(root: string, options: LocalWorkspaceOptions) {
    this.#root = root;
    this.#options = options;
  }

  /** The root, its links resolved once (the root itself is trusted; nothing below it is), held open. */
  async #openRoot(): Promise<Held> {
    try {
      this.#reach ??= { root: await realpath(this.#root), procFd: this.#options.procFd ?? LINUX, ...(this.#options.onHeld ? { onHeld: this.#options.onHeld } : {}) };
      return new Held(await open(this.#reach.root, DIR_FLAGS), this.#reach.root, this.#reach);
    } catch (error) {
      throw new WorkspaceError("UNAVAILABLE", `the workspace's folder ${this.#root} is not there`, { cause: error });
    }
  }

  /** The segments of `path`, which must name something below the root, not the root itself. */
  static #below(path: string, what: string): string[] {
    const segments = relativeSegments(path);
    if (segments.length === 0) throw new WorkspaceError("REFUSED", `the workspace's root is a directory, not ${what}`, { path: "" });
    return segments;
  }

  /**
   * `fn` given the folder of the first `count` segments, walked from the root and held open, each opened as a folder
   * through the one before it: a link is ESCAPE. A folder that is not there is NOT_FOUND, or with `make` it is made
   * and the folder above it synced. Something else in the way is EXISTS with `make`, else NOT_FOUND (or `notDir`, for
   * the last one walked). Every handle is closed once `fn` settles.
   */
  async #in<T>(path: string, segments: readonly string[], count: number, fn: (dir: Held) => Promise<T>, options: { make?: boolean; notDir?: WorkspaceErrorCode } = {}): Promise<T> {
    let dir = await this.#openRoot();
    try {
      for (let i = 0; i < count; i++) {
        const name = segments[i]!;
        const part = segments.slice(0, i + 1).join("/");
        let handle: FileHandle | undefined;
        for (let made = false; handle === undefined;) {
          try {
            handle = await dir.open(name, DIR_FLAGS);
          } catch (error) {
            const code = errno(error);
            if (code === "ENOENT" && options.make && !made) {
              made = true;
              try {
                await dir.confirm(path);
                await makeDir(dir.at(name), 0o777);
                await dir.handle.sync();
              } catch (making) {
                if (errno(making) !== "EEXIST") throw failed(making, path);
              }
              continue;
            }
            if (code === "ENOENT") throw new WorkspaceError("NOT_FOUND", `${show(part)} is not there`, { path });
            if (code !== "ENOTDIR" && code !== "ELOOP") throw failed(error, path);
            const stats = await lstatOrNot(dir.at(name)).catch(() => undefined);
            if (code === "ELOOP" || stats?.isSymbolicLink()) throw escape(part, path);
            throw new WorkspaceError(options.make ? "EXISTS" : i === count - 1 ? options.notDir ?? "NOT_FOUND" : "NOT_FOUND", `${show(part)} is not a directory`, { path });
          }
        }
        let next: Held;
        try {
          next = await dir.hold(handle, name);
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw error;
        }
        await dir.handle.close();
        dir = next;
      }
      return await fn(dir);
    } finally {
      await dir.handle.close().catch(() => undefined);
    }
  }

  async read(path: string, range?: { readonly offset?: number; readonly length?: number }): Promise<Uint8Array> {
    const offset = range?.offset ?? 0;
    const length = range?.length;
    if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) {
      throw new WorkspaceError("REFUSED", "a read's offset and length are whole numbers, 0 or more", { path });
    }
    if (length !== undefined && length > READ_MAX) throw new WorkspaceError("TOO_LARGE", `a read returns at most ${READ_MAX} bytes`, { path });
    const segments = LocalWorkspace.#below(path, "a file");
    return this.#in(path, segments, segments.length - 1, async (dir) => {
      let handle: FileHandle;
      try {
        handle = await dir.open(segments.at(-1)!, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      } catch (error) {
        throw failed(error, path);
      }
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new WorkspaceError("REFUSED", `${show(path)} is ${stats.isDirectory() ? "a directory" : "not a file"}`, { path });
        const there = Math.max(0, stats.size - offset);
        if (length === undefined && there > READ_MAX) throw new WorkspaceError("TOO_LARGE", `${show(path)} is ${stats.size} bytes; a read returns at most ${READ_MAX} (read it in ranges)`, { path });
        const buffer = Buffer.alloc(length === undefined ? there : Math.min(length, there));
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, offset + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return buffer.subarray(0, filled);
      } catch (error) {
        throw failed(error, path);
      } finally {
        await handle.close();
      }
    });
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = bytesOf(data);
    const segments = LocalWorkspace.#below(path, "a file");
    const name = segments.at(-1)!;
    await this.#in(path, segments, segments.length - 1, async (dir) => {
      try {
        const existing = await dir.confirmed(path, () => lstatOrNot(dir.at(name)));
        if (existing?.isSymbolicLink()) throw escape(path, path);
        if (existing !== undefined && !existing.isFile()) throw new WorkspaceError("REFUSED", `${show(path)} is ${existing.isDirectory() ? "a directory" : "not a file"}`, { path });
        const temp = `.workspace-${randomBytes(8).toString("hex")}.tmp`;
        const handle = await dir.open(temp, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o666);
        try {
          if (existing !== undefined) await handle.chmod(existing.mode & 0o777);
          await handle.writeFile(bytes);
          await handle.sync();
          await handle.close();
          await dir.confirm(path);
          await rename(dir.at(temp), dir.at(name));
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(dir.at(temp)).catch(() => undefined);
          throw error;
        }
        await dir.handle.sync();
      } catch (error) {
        throw failed(error, path);
      }
    }, { make: true });
  }

  async append(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = bytesOf(data);
    const segments = LocalWorkspace.#below(path, "a file");
    const target = segments.at(-1)!;
    await this.#in(path, segments, segments.length - 1, async (dir) => {
      try {
        let made = false;
        let handle: FileHandle;
        try {
          handle = await dir.open(target, O_RDWR | O_APPEND | O_NOFOLLOW | O_NONBLOCK);
        } catch (error) {
          if (errno(error) !== "ENOENT") throw error;
          try {
            handle = await dir.open(target, O_RDWR | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW, 0o666);
            made = true;
          } catch (again) {
            if (errno(again) !== "EEXIST") throw again;
            handle = await dir.open(target, O_RDWR | O_APPEND | O_NOFOLLOW | O_NONBLOCK);
          }
        }
        let stats: Stats;
        try {
          stats = await handle.stat();
          if (!stats.isFile()) throw new WorkspaceError("REFUSED", `${show(path)} is not a file`, { path });
          await handle.writeFile(bytes);
          await handle.datasync();
        } finally {
          await handle.close();
        }
        if (made) await dir.syncMade(target, stats, path);
      } catch (error) {
        throw failed(error, path);
      }
    }, { make: true });
  }

  async stat(path: string): Promise<Stat | undefined> {
    const segments = relativeSegments(path);
    const of = (stats: Stats): Stat => ({
      kind: stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "dir" : stats.isFile() ? "file" : "other",
      size: stats.isDirectory() ? 0 : stats.size,
      mtimeMs: stats.mtimeMs,
    });
    if (segments.length === 0) return this.#in(path, segments, 0, async (root) => of(await root.handle.stat()));
    try {
      return await this.#in(path, segments, segments.length - 1, async (dir) => {
        try {
          const stats = await dir.confirmed(path, () => lstatOrNot(dir.at(segments.at(-1)!)));
          return stats === undefined ? undefined : of(stats);
        } catch (error) {
          throw failed(error, path);
        }
      });
    } catch (error) {
      // A folder on the way not there, or a file in its place: nothing is at the path.
      if (error instanceof WorkspaceError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }

  async list(dir: string): Promise<Entry[]> {
    const segments = relativeSegments(dir);
    return this.#in(dir, segments, segments.length, async (held) => {
      try {
        // Off /proc/self/fd the folder is confirmed before and after: a listing of a folder swapped in is ESCAPE.
        const entries = await held.confirmed(dir, async () => Promise.all((await readdir(held.self)).map(async (name): Promise<Entry | undefined> => {
          const stats = await lstatOrNot(held.at(name));
          if (stats?.isDirectory()) return { name, kind: "dir", size: 0, mtimeMs: stats.mtimeMs };
          if (!stats?.isFile()) return undefined;
          // Only a flag for the listing: the read itself is what refuses (REFUSED, permission denied).
          const readable = await access(held.at(name), constants.R_OK).then(() => true, () => false);
          return { name, kind: "file", size: stats.size, mtimeMs: stats.mtimeMs, ...(readable ? {} : { unreadable: true as const }) };
        })));
        return entries.filter((entry): entry is Entry => entry !== undefined).sort((a, b) => byName(a.name, b.name));
      } catch (error) {
        throw failed(error, dir);
      }
    }, { notDir: "REFUSED" });
  }

  async mkdir(dir: string): Promise<void> {
    const segments = relativeSegments(dir);
    await this.#in(dir, segments, segments.length, async () => undefined, { make: true });
  }

  async grep(pattern: string, options: GrepOptions = {}): Promise<GrepResult> {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new WorkspaceError("REFUSED", `${JSON.stringify(pattern)} is not a regex: ${(error as Error).message}`, { cause: error });
    }
    const max = options.max ?? GREP_MAX;
    if (!Number.isSafeInteger(max) || max < 1) throw new WorkspaceError("REFUSED", "grep's max is a whole number, 1 or more");
    const timeMs = options.timeMs ?? GREP_TIME_MS;
    if (!Number.isFinite(timeMs) || timeMs <= 0) throw new WorkspaceError("REFUSED", "grep's timeMs is a number above 0");
    const from = options.path ?? "";
    const segments = relativeSegments(from);
    const job = { pattern, glob: options.glob, limit: Math.min(max, GREP_MAX), fileMax: GREP_FILE_MAX, lineMax: GREP_LINE_MAX, probe: BINARY_PROBE };
    // Off /proc/self/fd the worker opens each entry through no link below the root, as a read does (grep-worker.ts).
    const search = async (dir: Held, rel: string, only?: string): Promise<GrepResult> => {
      await dir.confirm(from);
      return LocalWorkspace.#searchIn({ ...job, dir: dir.self, rel, procFd: dir.reach.procFd, root: dir.reach.root, ...(only === undefined ? {} : { only }) }, Math.min(timeMs, GREP_TIME_MS));
    };
    if (segments.length === 0) return this.#in(from, segments, 0, (root) => search(root, ""));
    return this.#in(from, segments, segments.length - 1, async (parent) => {
      const name = segments.at(-1)!;
      const stats = await parent.confirmed(from, () => lstatOrNot(parent.at(name))).catch((error: unknown) => { throw failed(error, from); });
      if (stats === undefined) throw new WorkspaceError("NOT_FOUND", `${show(from)} is not there`, { path: from });
      if (stats.isSymbolicLink()) throw escape(from, from);
      if (stats.isFile()) return search(parent, segments.join("/"), name);
      if (!stats.isDirectory()) throw new WorkspaceError("REFUSED", `${show(from)} is neither a file nor a directory`, { path: from });
      const handle = await parent.open(name, DIR_FLAGS).catch((error: unknown) => { throw failed(error, from); });
      try {
        return await search(await parent.hold(handle, name), segments.join("/"));
      } finally {
        await handle.close();
      }
    });
  }

  /** `job` run in a worker, terminated after `timeMs`. Resolves once the worker is gone, so the folder it searched
   *  through can be let go. */
  static #searchIn(job: GrepJob, timeMs: number): Promise<GrepResult> {
    return new Promise<GrepResult>((resolve, reject) => {
      // No process flags: the worker needs none, and some it would inherit refuse a worker started from a file (the
      // launcher's `--input-type=module -e`).
      const worker = new Worker(GREP_WORKER, { workerData: job, execArgv: [] });
      const matches: GrepMatch[] = [];
      let done: GrepResult["truncated"] | undefined;
      let timedOut = false;
      let failure: unknown;
      const timer = setTimeout(() => { timedOut = true; void worker.terminate(); }, timeMs);
      worker.on("message", (message: { matches?: GrepMatch[]; done?: false | "max" }) => {
        if (message.matches) matches.push(...message.matches);
        if (message.done !== undefined) done = message.done;
      });
      worker.on("error", (error) => { failure = error; });
      worker.on("exit", () => {
        clearTimeout(timer);
        if (done !== undefined) resolve({ matches, truncated: done });
        else if (timedOut) resolve({ matches, truncated: "time" });
        else reject(new WorkspaceError("UNAVAILABLE", `grep failed: ${(failure as Error)?.message ?? "its worker stopped"}`, { cause: failure }));
      });
    });
  }

  async remove(path: string, options: { readonly recursive?: boolean; readonly force?: boolean } = {}): Promise<void> {
    const segments = relativeSegments(path);
    if (segments.length === 0) throw new WorkspaceError("REFUSED", "the workspace's root is never removed", { path: "" });
    const name = segments.at(-1)!;
    try {
      await this.#in(path, segments, segments.length - 1, async (dir) => {
        try {
          const stats = await dir.confirmed(path, () => lstatOrNot(dir.at(name)));
          if (stats === undefined) throw new WorkspaceError("NOT_FOUND", `${show(path)} is not there`, { path });
          if (stats.isSymbolicLink()) throw escape(path, path);
          if (!stats.isDirectory()) {
            await dir.confirm(path);
            await unlink(dir.at(name));
          } else {
            if (options.recursive) {
              const handle = await dir.open(name, DIR_FLAGS);
              try {
                await emptyTree(await dir.hold(handle, name), path);
              } finally {
                await handle.close();
              }
            }
            await dir.confirm(path);
            await rmdir(dir.at(name));
          }
          await dir.handle.sync();
        } catch (error) {
          throw failed(error, path);
        }
      });
    } catch (error) {
      if (options.force && error instanceof WorkspaceError && error.code === "NOT_FOUND") return;
      throw error;
    }
  }

  async exec(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === "string" && !arg.includes("\0")) || argv[0] === "") {
      throw new WorkspaceError("REFUSED", "exec takes argv: a program and its arguments, strings with no NUL");
    }
    const env = options.env;
    if (typeof env !== "object" || env === null || !Object.entries(env).every(([key, value]) => key !== "" && !/[=\0]/.test(key) && typeof value === "string" && !value.includes("\0"))) {
      throw new WorkspaceError("REFUSED", "exec's env is the whole environment: names and string values, with no NUL or \"=\" in a name");
    }
    const { timeoutMs } = options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WorkspaceError("REFUSED", "exec's timeoutMs is a number above 0");
    const cap = options.maxOutput ?? EXEC_OUTPUT_MAX;
    if (!Number.isSafeInteger(cap) || cap < 0) throw new WorkspaceError("REFUSED", "exec's maxOutput is a whole number, 0 or more");
    const cwd = options.cwd ?? "";
    const segments = relativeSegments(cwd);
    const { signal } = options;
    if (signal?.aborted) throw abortError(signal);
    // The child starts in the held folder itself (/proc/self/fd/<fd> on Linux), held until the child is done. Off
    // /proc/self/fd its path is confirmed just before the spawn.
    return this.#in(cwd, segments, segments.length, (dir) => dir.confirm(cwd).then(() => new Promise<ExecResult>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: dir.self,
        env: { ...env },
        detached: true,
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const kept = { out: 0, err: 0 };
      let truncated = false;
      let timedOut = false;
      let aborted = false;
      let exit: { code: number | null; signal: string | null } | undefined;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;

      /** Every process in its group killed: it leads its own (detached), so the group's id is its pid. */
      const killGroup = (): void => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
      };
      // Every byte goes to onOutput; the result keeps the first `cap` of each stream.
      const keep = (into: Buffer[], which: "out" | "err") => (chunk: Buffer): void => {
        if (options.onOutput) {
          try { options.onOutput({ stream: which === "out" ? "stdout" : "stderr", data: chunk }); } catch { /* the caller's callback; its error is not the call's */ }
        }
        const room = cap - kept[which];
        if (chunk.length > room) truncated = true;
        if (room <= 0) return;
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        into.push(part);
        kept[which] += part.length;
      };
      const onAbort = (): void => { aborted = true; killGroup(); };
      const finish = (): void => {
        if (settled || exit === undefined) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        signal?.removeEventListener("abort", onAbort);
        if (aborted) return reject(abortError(signal));
        resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), code: exit.code, signal: exit.signal, timedOut, truncated });
      };
      const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout!.on("data", keep(out, "out"));
      child.stderr!.on("data", keep(err, "err"));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        killGroup();
        const code = errno(error);
        reject(code === "ENOENT" ? new WorkspaceError("NOT_FOUND", `${JSON.stringify(argv[0])} is not a program here (PATH ${JSON.stringify(env.PATH ?? "")})`, { cause: error })
          : code === "EACCES" ? new WorkspaceError("REFUSED", `${JSON.stringify(argv[0])} is not executable`, { cause: error })
            : new WorkspaceError("UNAVAILABLE", `exec of ${JSON.stringify(argv[0])} failed: ${error.message}`, { cause: error }));
      });
      child.on("exit", (code, ended) => {
        // Node names the signal ("SIGTERM"); at the deadline it is the one that ended the program (our SIGKILL).
        exit = { code: timedOut ? null : code, signal: ended };
        clearTimeout(timer);
        killGroup();
        grace = setTimeout(() => { child.stdout!.destroy(); child.stderr!.destroy(); finish(); }, PIPE_GRACE_MS);
      });
      child.on("close", finish);
      if (options.stdin !== undefined) {
        child.stdin!.on("error", () => undefined);
        child.stdin!.end(Buffer.from(options.stdin.buffer, options.stdin.byteOffset, options.stdin.byteLength));
      }
    })), { notDir: "REFUSED" });
  }

  /** No computer: every background call is refused in words. */
  readonly process = noProcesses;

  /** A bind of the run's folder (its real path) at /workspace: the local Docker computer's mount. */
  async mountSpec(): Promise<MountSpec> {
    const root = await this.#openRoot();
    await root.handle.close();
    return { kind: "bind", path: root.abs };
  }

  async attach(computer: AttachableComputer, check: MountCheck): Promise<Workspace> {
    await checkReadBack(computer, await this.mountSpec(), check);
    return attachedWorkspace(this, computer, { synced: (path, only) => this.#syncUp(path, only) });
  }

  /** What a computer changed at `path` in this folder made durable on the host: the entry itself when it is there (a
   *  file or a folder, never through a link), then, unless `only` is "file", every folder from its own up to the root.
   *  A file this process may not read is synced through a write-only open. One it may neither read nor write (another
   *  account's private file, such as the computer's) cannot be synced from here: false says so, and the caller has the
   *  computer sync it; true is that the entry is synced, or gone. */
  async #syncUp(path: string, only?: "file"): Promise<boolean> {
    const segments = relativeSegments(path);
    const entry = await this.#in(path, segments, segments.length - 1, async (dir) => {
      for (const flags of [O_RDONLY, O_WRONLY]) {
        let handle: FileHandle;
        try {
          handle = await dir.open(segments.at(-1)!, flags | O_NOFOLLOW | O_NONBLOCK);
        } catch (error) {
          if (errno(error) === "ENOENT" || errno(error) === "ELOOP") return true;
          if (errno(error) !== "EACCES") throw failed(error, path);
          continue;
        }
        try { await handle.sync(); } finally { await handle.close(); }
        return true;
      }
      return false;
    });
    if (only !== "file") for (let count = segments.length - 1; count >= 0; count--) await this.#in(path, segments, count, (dir) => dir.handle.sync());
    return entry;
  }
}

/** A Workspace on folder `root` of this machine. The folder must be there when it is first used (else UNAVAILABLE).
 *  `options` are a test's: the path-resolving branch forced, and a hook where a swap would land. */
export const localWorkspace = (root: string, options: LocalWorkspaceOptions = {}): Workspace => new LocalWorkspace(root, options);

/** `work` as a Workspace: a folder of this machine, by its path, becomes its LocalWorkspace. For the callers that still
 *  hand a run's folder by its path (the run's start and its process), until they hand the run's Workspace. */
export const workspaceAt = (work: string | Workspace): Workspace => (typeof work === "string" ? localWorkspace(work) : work);
