// Containment of the in-process file operations. pi's read, write and edit run in the loop's process with host
// fs calls and no containment, so an agent can name `../store/run.sqlite`, `../run.json` or `../owner.lock` and corrupt
// its own durable store or claim; a sandbox that confines commands (an app's own) does not cover them. Every path an operation names is
// resolved to the file the kernel would reach (symlinks followed, a missing tail kept) and refused unless it lies in the
// workspace, or, for reads, in a read-only root.
//
// The check alone is a check-then-use: a command running next to the tool can swap a component for a symlink between the
// check and the open. So the operation never walks the path again. The resolved path is opened one component at a time
// from a pinned directory handle of its root, each step relative to the previous handle and with O_NOFOLLOW, which is
// openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS) done in user space. Node has no openat, so a handle's directory is named
// `/proc/self/fd/<fd>`: the kernel jumps straight to the held inode there and never re-walks the directory's own path. A
// swapped component fails the open (ELOOP or ENOTDIR) and the call is refused as changed; nothing is retried.
import { constants, existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readlink, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { err, FileError, ok } from "@earendil-works/pi-durable/env";
import type { BinaryReader, DirReader, FileErrorCode, FileInfo, Result } from "@earendil-works/pi-durable/env";

export type RefusalReason = "outside_work" | "changed";

/**
 * A file operation named a path that is not under the workspace (`outside_work`), or one whose components changed
 * while it was being resolved (`changed`). pi turns it into a failed tool result that names the path. Its `code` is pi's
 * `permission_denied`.
 */
export class PathOutsideWorkError extends FileError {
  readonly reason: RefusalReason;
  constructor(path: string, reason: RefusalReason, message: string) {
    super("permission_denied", message, path);
    this.name = "PathOutsideWorkError";
    this.reason = reason;
  }
}

const MAX_LINKS = 40;
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// Nonblocking, so opening a FIFO does not wait for a peer; a regular file is unaffected.
const FILE = constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Test seam: runs after a path was resolved and checked, before anything is opened. */
export const confineHooks: { afterCheck?: (canonical: string) => Promise<void> | void } = {};

function errno(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

const isMissing = (error: unknown) => errno(error) === "ENOENT" || errno(error) === "ENOTDIR";

const FILE_ERRORS: Readonly<Record<string, FileErrorCode>> = {
  ABORT_ERR: "aborted",
  ENOENT: "not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  ENOTDIR: "not_directory",
  EISDIR: "is_directory",
  EINVAL: "invalid",
  ELOOP: "invalid",
};

/** pi's mapping from a Node error to its `FileError` codes (pi does not export it). */
export function fileError(error: unknown, path: string): FileError {
  if (error instanceof FileError) return error;
  const cause = error instanceof Error ? error : new Error(String(error));
  const code = errno(cause);
  return new FileError((code !== undefined && FILE_ERRORS[code]) || "unknown", cause.message, path, cause);
}

/**
 * The path the kernel would reach for `path` (absolute, lexically normalized): every existing component resolved,
 * symlinks included, dangling ones followed to where they would create; a missing tail is appended as it is.
 */
export async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  let resolved = "/";
  let links = 0;
  const pending = path.split("/").filter((part) => part !== "");
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (name === ".") continue;
    if (name === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const next = join(resolved, name);
    let stats;
    try {
      stats = await lstat(next);
    } catch (error) {
      if (isMissing(error)) return join(next, ...pending);
      throw error;
    }
    if (!stats.isSymbolicLink()) {
      resolved = next;
      continue;
    }
    if (++links > MAX_LINKS) throw Object.assign(new Error(`ELOOP: too many symbolic links, '${path}'`), { code: "ELOOP" });
    const target = await readlink(next);
    if (target.startsWith("/")) resolved = "/";
    pending.unshift(...target.split("/").filter((part) => part !== ""));
  }
  return resolved;
}

/** `canonicalize` for a directory that may not exist yet, at construction. */
export function canonicalizeSync(path: string): string {
  let existing = path;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const up = dirname(existing);
    if (up === existing) break;
    tail.unshift(basename(existing));
    existing = up;
  }
  return join(realpathSync(existing), ...tail);
}

export const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

export interface PinSpec {
  readonly access: "read" | "write";
  /** Whether the last component is followed when it is a symlink; `false` for operations on the link itself. */
  readonly follow: boolean;
  /** Create the missing directories above the target. */
  readonly parents?: boolean;
  /** Refuse the root itself as the target (remove, rename). */
  readonly strict?: boolean;
}

const FILE_INFO_KEYS = ["name", "path", "kind", "size", "mtimeMs"] as const;
const isFileInfo = (value: unknown): value is FileInfo =>
  typeof value === "object" && value !== null && FILE_INFO_KEYS.every((key) => key in value) && typeof (value as FileInfo).path === "string";

/**
 * A resolved target held open. `dir` and `entry` are `/proc/self/fd/...` paths to hand to pi's own implementation; every
 * path and message it returns is mapped back to the real one with `restore`. Close it when the operation is done.
 */
export class Pin {
  readonly canonical: string;
  /** The last component, or "" when the target is the root itself. */
  readonly name: string;
  /** The held directory: the target itself for a directory pin, the directory holding the target for an entry pin. */
  readonly dir: string;
  /** The target below `dir`, for operations that do not follow a last symlink. */
  readonly entry: string;
  readonly #handle: FileHandle;
  /** What `dir` stands for: the directory itself, or the directory holding the entry. */
  readonly #real: string;
  #closed = false;

  constructor(handle: FileHandle, canonical: string, name: string, dirMode: boolean) {
    this.#handle = handle;
    this.canonical = canonical;
    this.name = name;
    this.dir = `/proc/self/fd/${handle.fd}`;
    this.entry = dirMode ? this.dir : name === "" ? `${this.dir}/.` : `${this.dir}/${name}`;
    this.#real = dirMode || name === "" ? canonical : dirname(canonical);
  }

  /** `text` with the held paths replaced by the real ones. */
  translate(text: string): string {
    return text.split(this.entry).join(this.canonical).split(this.dir).join(this.#real);
  }

  /** An error pi or Node raised on a held path, as a FileError that names the real one. */
  error(error: unknown, path: string): FileError {
    if (error instanceof PathOutsideWorkError) return error;
    const mapped = fileError(error, path);
    return new FileError(mapped.code, this.translate(mapped.message), mapped.path === undefined ? path : this.translate(mapped.path), mapped.cause instanceof Error ? mapped.cause : undefined);
  }

  restore<T>(result: Result<T, FileError>): Result<T, FileError> {
    if (!result.ok) return err(this.error(result.error, result.error.path ?? this.canonical));
    return ok(this.#value(result.value) as T);
  }

  #value(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((each) => this.#value(each));
    if (isFileInfo(value)) return { ...value, path: this.translate(value.path) };
    // A page of a directory reader.
    if (typeof value === "object" && value !== null && "entries" in value && Array.isArray(value.entries)) {
      return { ...value, entries: this.#value(value.entries) };
    }
    return value;
  }

  /** Opens the target's last component, which is never followed, and returns its handle; the caller closes it. */
  async openFile(flags: number, mode?: number): Promise<FileHandle> {
    try {
      return await open(this.entry, flags | FILE, mode);
    } catch (error) {
      if (errno(error) === "ELOOP") throw changed(this.canonical);
      throw error;
    }
  }

  binaryReader(reader: BinaryReader): BinaryReader {
    return {
      info: async (context) => this.restore(await reader.info(context)),
      read: (offset, length, context) => reader.read(offset, length, context),
      scanLines: (options, context) => reader.scanLines(options, context),
      close: (context) => reader.close(context),
    };
  }

  /** The reader keeps the pin open: pi's reader names each entry through `dir` as it pages. */
  dirReader(reader: DirReader): DirReader {
    return {
      next: async (maxEntries, context) => this.restore(await reader.next(maxEntries, context)),
      close: async (context) => {
        try {
          await reader.close(context);
        } finally {
          await this.close();
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close().catch(() => undefined);
  }
}

const changed = (path: string) =>
  new PathOutsideWorkError(path, "changed", `${path}: a component of the path changed while it was being resolved, so the operation was refused`);

export class Confinement {
  readonly work: string;
  readonly readOnly: readonly string[];

  /** Canonical directories: `work` may be read and written, `readOnly` only read. */
  constructor(work: string, readOnly: readonly string[]) {
    this.work = work;
    this.readOnly = readOnly;
  }

  /** Resolves `abs` and refuses it unless it lies under an allowed root; returns the root that holds it. */
  async locate(abs: string, original: string, access: "read" | "write", follow: boolean): Promise<{ canonical: string; root: string }> {
    const canonical = follow ? await canonicalize(abs) : join(await canonicalize(dirname(abs)), basename(abs));
    const roots = access === "write" ? [this.work] : [this.work, ...this.readOnly];
    const root = roots.find((candidate) => inside(canonical, candidate));
    if (root === undefined) {
      const where = canonical === abs ? "" : ` (it resolves to ${canonical})`;
      throw new PathOutsideWorkError(original, "outside_work", `${original}: outside the workspace ${this.work}${where}`);
    }
    return { canonical, root };
  }

  /** Pins the directory holding the target (or the root, when it is the target). */
  async pinEntry(abs: string, original: string, spec: PinSpec): Promise<Pin> {
    const { canonical, root } = await this.locate(abs, original, spec.access, spec.follow);
    await confineHooks.afterCheck?.(canonical);
    const names = relative(root, canonical);
    if (names.length === 0 && spec.strict === true) {
      throw new PathOutsideWorkError(original, "outside_work", `${original}: the workspace root itself cannot be removed or renamed`);
    }
    const name = names.pop() ?? "";
    const handle = await walk(root, names, spec.parents === true ? "all" : "none", canonical);
    return new Pin(handle, canonical, name, false);
  }

  /** Pins the target directory itself; `create` makes it and the directories above it when they are missing. */
  async pinDir(abs: string, original: string, spec: { access: "read" | "write"; create?: boolean }): Promise<Pin> {
    const { canonical, root } = await this.locate(abs, original, spec.access, true);
    await confineHooks.afterCheck?.(canonical);
    const handle = await walk(root, relative(root, canonical), spec.create === true ? "all" : "none", canonical);
    return new Pin(handle, canonical, basename(canonical), true);
  }
}

const relative = (root: string, path: string): string[] => (path === root ? [] : path.slice(root.length + (root.endsWith("/") ? 0 : 1)).split("/"));

/** The error with the held path `from` in its message replaced by the real one; the errno is kept. */
function retarget(error: unknown, from: string, to: string): unknown {
  if (!(error instanceof Error)) return error;
  return Object.assign(new Error(error.message.split(from).join(to), { cause: error }), { code: errno(error) });
}

/** Whether a failed directory open found a symlink: O_DIRECTORY with O_NOFOLLOW reports it as ENOTDIR, as it does a file. */
async function swapped(error: unknown, path: string): Promise<boolean> {
  if (errno(error) === "ELOOP") return true;
  if (errno(error) !== "ENOTDIR") return false;
  return (await lstat(path).catch(() => undefined))?.isSymbolicLink() === true;
}

/** Opens `root`, then each name below it, every step relative to the handle before it and without following links. */
async function walk(root: string, names: readonly string[], create: "none" | "all", canonical: string): Promise<FileHandle> {
  let dir: FileHandle;
  try {
    dir = await open(root, DIRECTORY);
  } catch (error) {
    if (await swapped(error, root)) throw changed(canonical);
    throw error;
  }
  try {
    // The root was opened by name: it must be the directory that name denotes now, not one swapped in on the way.
    const actual = await readlink(`/proc/self/fd/${dir.fd}`);
    if (actual !== root) throw changed(canonical);
    let real = root;
    for (const name of names) {
      if (name === "" || name === "." || name === ".." || name.includes("\0")) throw changed(canonical);
      const step = `/proc/self/fd/${dir.fd}/${name}`;
      real = join(real, name);
      let next: FileHandle;
      try {
        next = await open(step, DIRECTORY);
      } catch (error) {
        if (create === "all" && errno(error) === "ENOENT") {
          await mkdir(step).catch((made) => {
            if (errno(made) !== "EEXIST") throw retarget(made, step, real);
          });
          next = await open(step, DIRECTORY).catch((opened) => {
            throw retarget(opened, step, real);
          });
        } else if (await swapped(error, step)) {
          throw changed(canonical);
        } else {
          throw retarget(error, step, real);
        }
      }
      await dir.close();
      dir = next;
    }
    return dir;
  } catch (error) {
    await dir.close().catch(() => undefined);
    throw error;
  }
}
