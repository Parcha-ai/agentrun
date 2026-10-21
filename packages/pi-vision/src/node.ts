// The environment port over Node's file system and child processes, for a host whose `read` is its own: files are read
// and written where this process runs, and programs run by argv with no shell (a string runs through `/bin/sh -c`). It
// keeps pi-durable's `NodeExecutionEnv` contract for the members the package uses: a relative path resolves against
// `cwd`, every method returns a result and never throws, error codes are pi's (`not_found`, `permission_denied`,
// `is_directory`, `aborted`, `timeout`, ...), `timeout` is in seconds, and an aborted or timed-out program is killed
// with its whole process group. One thing differs from pi's: a program is never given this process's whole
// environment. A host keeps credentials there, a program here reads files the host did not write, and a child's
// environment can be read by other processes of its user. A program gets the environment the host names, or the few
// variables of `inheritedEnv()`.
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { constants as os, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hideDirs } from "./core/paths.js";
import type { VisionBinaryReader, VisionContext, VisionEnv, VisionEnvError, VisionFileInfo, VisionResult } from "./core/env.js";

type Result<T> = VisionResult<T, VisionEnvError>;

/** The environment a program is started with: names to values; a name with no value is left out. */
export type ChildEnv = Readonly<Record<string, string | undefined>>;

/** The names a program is given from this process's environment when the host names none: where programs and their
 *  libraries are found, the home and temporary directories, the locale and the time zone, and what Windows needs to
 *  start a program at all. Nothing else is copied. */
const INHERITED = /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|DYLD_FALLBACK_LIBRARY_PATH|SYSTEMROOT|WINDIR|PATHEXT|COMSPEC|USERPROFILE)$/;

const defined = (env: ChildEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

/** What a program gets of this process's environment by default, read when it is called. A host that wants a program
 *  to have more passes `{ ...inheritedEnv(), NAME: value }`. */
export function inheritedEnv(): Record<string, string> {
  const named = (name: string) => INHERITED.test(process.platform === "win32" ? name.toUpperCase() : name);
  return defined(Object.fromEntries(Object.entries(process.env).filter(([name]) => named(name))));
}

/** The environment of the programs a host's option names: the host's as it is, else the default. */
export const childEnvOf = (env: ChildEnv | undefined): Record<string, string> => (env ? defined(env) : inheritedEnv());

const FILE_CODES: Readonly<Record<string, string>> = {
  ABORT_ERR: "aborted", ENOENT: "not_found", EACCES: "permission_denied", EPERM: "permission_denied", ENOTDIR: "not_directory",
  EISDIR: "is_directory", EINVAL: "invalid", ELOOP: "invalid", EMLINK: "invalid",
};

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: string, message: string): Result<never> => ({ ok: false, error: Object.assign(new Error(message), { code }) });
/** An error's words, with the absolute paths it names (its `path` and `dest`) cut to their last part: the host's
 *  directories are no part of what a caller is told. */
const said = (error: unknown): string => {
  const named = (error ?? {}) as { path?: unknown; dest?: unknown };
  return hideDirs(error instanceof Error ? error.message : String(error), named.path, named.dest);
};
const failed = (error: unknown): Result<never> => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return fail(typeof code === "string" ? (FILE_CODES[code] ?? "unknown") : "unknown", said(error));
};
const abortedResult = (context: VisionContext) => (context.abortSignal?.aborted ? fail("aborted", "aborted") : undefined);

async function attempt<T>(context: VisionContext, run: () => Promise<T>): Promise<Result<T>> {
  const cut = abortedResult(context);
  if (cut) return cut;
  try {
    const value = await run();
    return abortedResult(context) ?? ok(value);
  } catch (error) {
    return failed(error);
  }
}

function infoOf(path: string, stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number }): VisionFileInfo {
  const kind = stats.isFile() ? "file" : stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : undefined;
  if (!kind) throw Object.assign(new Error(`${path} is not a file, a directory or a link`), { code: "EINVAL" });
  return { name: basename(path), path, kind, size: stats.size, mtimeMs: stats.mtimeMs };
}

/** Positional reads of one open file: a rename of its path after the open changes nothing it reads. */
function binaryReader(file: FileHandle, path: string): VisionBinaryReader {
  let closed = false;
  const shut = () => (closed ? fail("closed", `the reader of ${path} is closed`) : undefined);
  return {
    info: async (context) => shut() ?? attempt(context, async () => infoOf(path, await file.stat())),
    read: async (offset, length, context) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) return fail("invalid", "offset and length must be non-negative safe integers");
      return shut() ?? attempt(context, async () => {
        // At most what the file holds past `offset`, so a length meaning "to the end" allocates only that.
        const buffer = new Uint8Array(Math.max(0, Math.min(length, (await file.stat()).size - offset)));
        let total = 0;
        for (let got = -1; got !== 0 && total < buffer.length; total += got) got = (await file.read(buffer, total, buffer.length - total, offset + total)).bytesRead;
        return buffer.subarray(0, total);
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await file.close().catch(() => undefined);
    },
  };
}

function killGroup(pid: number | undefined) {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

type ExecOptions = NonNullable<Parameters<VisionEnv["exec"]>[1]>;

/** The Node port: a `VisionEnv` whose `exec` also takes pi's `inheritEnv`. A call that says `inheritEnv: false` names
 *  the program's whole environment in its own `env`. */
export type NodeVisionEnv = Omit<VisionEnv, "exec"> & {
  exec(command: Parameters<VisionEnv["exec"]>[0], options: (ExecOptions & { inheritEnv?: boolean }) | undefined, context: VisionContext): ReturnType<VisionEnv["exec"]>;
};

/** `env` is the whole environment of every program this environment starts; without it, `inheritedEnv()`. A call's own
 *  `env` is added over either, and is the whole of it when the call says `inheritEnv: false`. */
export function nodeVisionEnv(options: { cwd: string; env?: ChildEnv }): NodeVisionEnv {
  const absolute = (path: string) => (isAbsolute(path) ? resolve(path) : resolve(env.cwd, path));
  const env: NodeVisionEnv = {
    id: "node:local",
    cwd: options.cwd,
    readBinaryFile: (path, context) => attempt(context, async () => new Uint8Array(await readFile(absolute(path), { signal: context.abortSignal }))),
    openBinaryReader: async (path, opened, context) => {
      const cut = abortedResult(context);
      if (cut) return cut;
      let file: FileHandle;
      try {
        // Nonblocking, so opening a FIFO never waits for a writer; anything but a regular file is refused below.
        file = await open(absolute(path), constants.O_RDONLY | constants.O_NONBLOCK | (opened?.noFollow ? constants.O_NOFOLLOW : 0));
      } catch (error) {
        const refused = failed(error);
        return !refused.ok && refused.error.code === "invalid" && opened?.noFollow ? fail("invalid", `refusing to follow a symbolic link: ${path}`) : refused;
      }
      // Every way out but the reader closes the file, a cancellation after the open included.
      const stats = await file.stat().catch((error: unknown) => error as Error);
      const refusal = stats instanceof Error ? failed(stats) : stats.isDirectory() ? fail("is_directory", `${path} is a directory`) : !stats.isFile() ? fail("invalid", `${path} is not a regular file`) : abortedResult(context);
      if (refusal) {
        await file.close().catch(() => undefined);
        return refusal;
      }
      return ok(binaryReader(file, absolute(path)));
    },
    writeFile: (path, content, context) => attempt(context, async () => {
      await mkdir(dirname(absolute(path)), { recursive: true });
      await writeFile(absolute(path), content, { signal: context.abortSignal });
    }),
    renameFile: (from, to, context) => attempt(context, () => rename(absolute(from), absolute(to))),
    createDir: (path, created, context) => attempt(context, async () => { await mkdir(absolute(path), { recursive: created?.recursive ?? true }); }),
    createTempDir: (prefix, context) => attempt(context, () => mkdtemp(join(tmpdir(), prefix ?? "tmp-"))),
    fileInfo: (path, context) => attempt(context, async () => infoOf(absolute(path), await lstat(absolute(path)))),
    remove: (path, removed, context) => attempt(context, () => rm(absolute(path), { recursive: removed?.recursive ?? false, force: removed?.force ?? false })),
    exec: async (command, run, context) => {
      const cut = abortedResult(context);
      if (cut) return cut;
      const argv = typeof command === "string" ? ["/bin/sh", "-c", command] : command;
      if (!argv[0]) return fail("spawn_error", "empty argv: no program to run");
      if (run?.timeout !== undefined && !(Number.isFinite(run.timeout) && run.timeout > 0)) return fail("timeout", "timeout must be a positive number of seconds");
      const own = run?.inheritEnv === false;
      return new Promise<Result<{ exitCode: number }>>((settle) => {
        let child: ChildProcess;
        try {
          child = spawn(argv[0]!, argv.slice(1), { cwd: run?.cwd ? absolute(run.cwd) : env.cwd, env: { ...(own ? {} : childEnvOf(options.env)), ...run?.env }, stdio: "ignore", detached: true });
        } catch (error) {
          // An argument spawn refuses outright (a NUL byte) is a failed result like any other.
          settle(fail("spawn_error", said(error)));
          return;
        }
        let cause: "timeout" | "aborted" | undefined;
        const stop = (why: "timeout" | "aborted") => { cause ??= why; killGroup(child.pid); };
        const onAbort = () => stop("aborted");
        const timer = run?.timeout === undefined ? undefined : setTimeout(() => stop("timeout"), run.timeout * 1000);
        context.abortSignal?.addEventListener("abort", onAbort, { once: true });
        const done = (result: Result<{ exitCode: number }>) => {
          clearTimeout(timer);
          context.abortSignal?.removeEventListener("abort", onAbort);
          settle(result);
        };
        child.once("error", (error) => done(fail("spawn_error", said(error))));
        child.once("close", (code, signal) => done(cause ? fail(cause, cause) : ok({ exitCode: code ?? (signal ? 128 + (os.signals[signal] ?? 0) : 1) })));
      });
    },
  };
  return env;
}
