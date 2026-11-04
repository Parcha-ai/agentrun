// The file tools of a run whose box binds its work/ from this machine (Docker here): read, write and edit run on this
// machine, on the bind's source, and not as commands in the box, which cost one `docker exec` or more each (half a second
// and up on real Docker). bash stays in the box. This holds only where the confinement walks held directory handles
// (workspace.ts writesHeld: Linux's /proc/self/fd): a command in the box runs beside these tools and can plant a link, a
// hard link or a swapped directory at any moment, and only a walk on held handles refuses a swap between the check and
// the use. Elsewhere (macOS, a box that binds nothing, Daytona's) all four stay in the box (coding-tools.ts).
//
// Nothing a box's command makes in work/ is followed or taken. Every path is work/ joined with its own names, and a link
// anywhere on the way is refused, even one pointing inside work/. Only a regular file with one hard link is read or
// written. A write goes through a temporary file renamed over the old one, keeping its mode (workspace.ts
// writeWorkFile). work/ itself must be its own canonical path: the directory the box was given (run-box.ts
// mountSource). The model names the box's paths (BOX_WORK), mapped one for one onto the bind's source; every path and
// message it gets back names the box's, never this machine's.
import { realpathSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type BinaryReader, err, ExecutionError, type ExecutionEnv, FileError, type FileErrorCode, ok, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { PathOutsideWorkError } from "@parcha/pi-durable-disk";
import { BOX_WORK } from "./place.js";
import { openWorkFile, type RefusedReason, WorkRefused, writeWorkFile } from "./workspace.js";

/** What a refusal tells the model, by the path it named: what is wrong, and that bash, in the box, can still reach it. */
const REFUSED: Readonly<Record<Exclude<RefusedReason, "missing">, (path: string) => string>> = {
  link: (path) => `${path}: refused: a link is on the way to it, or it is one, and read, write and edit follow no link in this run's work/ (bash, in the box, can)`,
  hard_link: (path) => `${path}: refused: it has another hard link, and read, write and edit take only a file with one (bash, in the box, can)`,
  not_regular: (path) => `${path}: refused: it is not a regular file`,
  unreadable: (path) => `${path}: refused: this server may not read it (a command in the box made it private)`,
  over_cap: (path) => `${path}: refused: it is too large`,
  unheld: (path) => `${path}: refused: this host reaches the run's directories by path`,
};

const NODE_CODES: Readonly<Record<string, FileErrorCode>> = { ENOENT: "not_found", EACCES: "permission_denied", EPERM: "permission_denied", ENOTDIR: "not_directory", EISDIR: "is_directory", ELOOP: "invalid" };

/** A box run's read, write and edit environment on this machine's `hostWork` (canonical: the bind's source), naming the
 *  box's paths. Its shell runs nothing, and only the operations those tools make are offered. */
export function boundFiles(hostWork: string): ExecutionEnv {
  // pi's own implementation, only ever handed a checked handle's /proc/self/fd entry, which names that inode and no path.
  const node = new NodeExecutionEnv({ cwd: hostWork });
  /** `text` with this machine's work/ named as the box names it. */
  const boxed = (text: string) => text.split(`${hostWork}/`).join(`${BOX_WORK}/`).split(hostWork).join(BOX_WORK);
  // The confinement's typed refusal, its message naming no path: the tools name it by the path the call gave
  // (workspace-paths.ts asGivenRefusals). It crosses from pi-durable-disk's pi-durable as a value, typed on this side.
  const outside = (path: string) => new PathOutsideWorkError(path, "outside_work", "outside the workspace") as unknown as FileError;
  /** `path` as an absolute path of the box, or the refusal of one outside its work/. */
  const absolute = (path: string): Result<string, FileError> => {
    const abs = posix.resolve(BOX_WORK, path);
    return abs === BOX_WORK || abs.startsWith(`${BOX_WORK}/`) ? ok(abs) : err(outside(path));
  };
  const failure = (error: unknown, path: string): FileError => {
    if (error instanceof WorkRefused) {
      if (error.reason === "missing") return new FileError("not_found", `ENOENT: no such file or directory, open '${path}'`, path);
      return new FileError("permission_denied", REFUSED[error.reason](path), path);
    }
    if (error instanceof FileError) return new FileError(error.code, boxed(error.message), path, error);
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return new FileError((code && NODE_CODES[code]) || "unknown", boxed((error as Error)?.message ?? String(error)), path);
  };
  /** The work/ the box was given: refused when it is no longer its own canonical path (swapped for a link). */
  const root = () => {
    if (realpathSync(hostWork) !== hostWork) throw new WorkRefused(".", "link");
  };
  /** `use` on the file at `path`, opened held: a regular file with one link, reached through no link. */
  async function opened<T>(path: string, use: (handle: FileHandle, info: { size: number; mtimeMs: number }, abs: string) => Promise<T>): Promise<Result<T, FileError>> {
    const abs = absolute(path);
    if (!abs.ok) return abs;
    const rel = posix.relative(BOX_WORK, abs.value);
    if (rel === "") return err(new FileError("is_directory", `${abs.value}: is the run's work directory, not a file`, abs.value));
    try {
      root();
      const { handle, stats } = await openWorkFile(hostWork, rel);
      try {
        return ok(await use(handle, stats, abs.value));
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      return err(failure(error, abs.value));
    }
  }
  /** pi's reader of a checked handle, its info naming the box's path. */
  const reader = async (handle: FileHandle, abs: string, context: Context): Promise<BinaryReader> => {
    const made = await node.openBinaryReader(`/proc/self/fd/${handle.fd}`, undefined, context);
    if (!made.ok) throw made.error;
    const inner = made.value;
    return {
      info: async (at) => {
        const info = await inner.info(at);
        return info.ok ? ok({ ...info.value, name: posix.basename(abs), path: abs }) : err(failure(info.error, abs));
      },
      read: (offset, length, at) => inner.read(offset, length, at),
      scanLines: (options, at) => inner.scanLines(options, at),
      close: (at) => inner.close(at),
    };
  };
  /** An operation read, write and edit never make: refused, so nothing else of this machine is reached through it. */
  const unoffered = (name: string) => async (): Promise<Result<never, FileError>> =>
    err(new FileError("not_supported", `${name} is not offered here: a box run's file tools on this machine read, write and edit, and bash runs in the box`));

  return {
    id: `bound-work:${hostWork}`,
    cwd: BOX_WORK,
    absolutePath: async (path) => absolute(path),
    joinPath: async (parts) => ok(posix.join(...parts)),
    // The mutation queue then keys a file by its absolute path: a link is never followed here, so that is the file.
    canonicalPath: unoffered("canonicalPath"),
    exists: async (path) => {
      const abs = absolute(path);
      if (!abs.ok) return abs;
      const found = await opened(abs.value, async () => true);
      // A file refused is there: the operation that follows says why.
      return found.ok || found.error.code !== "not_found" ? ok(true) : ok(false);
    },
    fileInfo: (path) => opened(path, async (_handle, info, abs) => ({ name: posix.basename(abs), path: abs, kind: "file" as const, size: info.size, mtimeMs: info.mtimeMs })),
    readTextFile: (path, context) => opened(path, (handle) => handle.readFile({ encoding: "utf8", ...(context.abortSignal ? { signal: context.abortSignal } : {}) })),
    readBinaryFile: (path, context) => opened(path, async (handle) => new Uint8Array(await handle.readFile(context.abortSignal ? { signal: context.abortSignal } : {}))),
    openBinaryReader: (path, _options, context) => opened(path, (handle, _info, abs) => reader(handle, abs, context)),
    openTextLineReader: (path, context) =>
      opened(path, async (handle, _info, abs) => {
        const made = await node.openTextLineReader(`/proc/self/fd/${handle.fd}`, context);
        if (!made.ok) throw failure(made.error, abs);
        return made.value;
      }),
    readTextLines: (path, options, context) =>
      opened(path, async (handle, _info, abs) => {
        const read = await node.readTextLines(`/proc/self/fd/${handle.fd}`, options, context);
        if (!read.ok) throw failure(read.error, abs);
        return read.value;
      }),
    writeFile: async (path, content) => {
      const abs = absolute(path);
      if (!abs.ok) return abs;
      const rel = posix.relative(BOX_WORK, abs.value);
      if (rel === "") return err(new FileError("is_directory", `${abs.value}: is the run's work directory, not a file`, abs.value));
      try {
        root();
        // A new file as a box's command would make it (0644); one already there keeps its mode.
        await writeWorkFile(hostWork, rel, typeof content === "string" ? Buffer.from(content) : content, 0o644, true);
        return ok(undefined);
      } catch (error) {
        return err(failure(error, abs.value));
      }
    },
    appendFile: unoffered("appendFile"),
    truncateFile: unoffered("truncateFile"),
    flushFile: unoffered("flushFile"),
    renameFile: unoffered("renameFile"),
    listDir: unoffered("listDir"),
    openDirReader: unoffered("openDirReader"),
    watch: unoffered("watch"),
    createDir: unoffered("createDir"),
    remove: unoffered("remove"),
    createTempDir: unoffered("createTempDir"),
    createTempFile: unoffered("createTempFile"),
    exec: async () => err(new ExecutionError("shell_unavailable", "this environment runs no command: bash runs in the box")),
    cleanup: async () => undefined,
  };
}
