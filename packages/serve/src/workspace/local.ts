// LocalWorkspace: a Workspace on a folder of this machine, through node:fs, and exec as a local child process.
//
// Confinement. Every path is checked by paths.ts relativeSegments, then walked from the root one folder at a time with
// lstat: each must be a real folder, never a symbolic link (ESCAPE). The last part is opened with O_NOFOLLOW, so a link
// there is ESCAPE too. On Linux, a file it opened is then checked through /proc/self/fd to be inside the root, which
// catches a folder swapped for a link between the walk and the open. exec's cwd is walked the same way.
//
// Durability. write is a temporary file in the same folder (O_EXCL), its bytes, fsync, rename over the name, then fsync
// of the folder. append is O_APPEND, its bytes, fdatasync, and the folder's fsync when it made the file. mkdir fsyncs
// the folder above each one it made; remove fsyncs the folder it removed from. Each returns once that is done. Files
// written are opened read-write, not write-only, so a crash test's fsync shim can copy what each sync made durable.
//
// No locks: two calls on one path race as two processes would (workspace.ts).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir as makeDir, open, readdir, readlink, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { relativeSegments } from "./paths.js";
import {
  EXEC_OUTPUT_MAX, type Entry, type ExecOptions, type ExecResult, GREP_FILE_MAX, GREP_LINE_MAX, GREP_MAX, GREP_TIME_MS,
  type GrepMatch, type GrepOptions, type GrepResult, READ_MAX, type Workspace, WorkspaceError,
} from "./workspace.js";

const { O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_RDWR } = constants;
/** After the process it ran exits, how long exec waits for its output pipes to close before it closes them itself (a
 *  process that left the group can hold them). */
const PIPE_GRACE_MS = 500;
/** git's rule for a binary file: a NUL in its first 8000 bytes. */
const BINARY_PROBE = 8000;

const show = (path: string): string => JSON.stringify(path === "" ? "." : path);
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** A node:fs failure as a WorkspaceError. */
function failed(error: unknown, path: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const at = { path, cause: error };
  switch (errno(error)) {
    case "ENOENT":
    case "ENOTDIR": return new WorkspaceError("NOT_FOUND", `${show(path)} is not there`, at);
    case "ELOOP": return new WorkspaceError("ESCAPE", `${show(path)} is a symbolic link, and a workspace follows none`, at);
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

/** Folder `dir`'s entries made durable. */
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, O_RDONLY | O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

const bytesOf = (data: Uint8Array | string): Uint8Array => {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return data;
  throw new WorkspaceError("REFUSED", "data is bytes (a Uint8Array) or a string");
};

/** A glob (`*`, `**`, `?`) as a regex over a relative path. */
function globRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

class LocalWorkspace implements Workspace {
  readonly #root: string;
  #real: string | undefined;

  constructor(root: string) {
    this.#root = root;
  }

  /** The root, its links resolved once (the root itself is trusted; nothing below it is). */
  async #base(): Promise<string> {
    if (this.#real !== undefined) return this.#real;
    try {
      const real = await realpath(this.#root);
      if (!(await lstat(real)).isDirectory()) throw new Error("not a directory");
      return (this.#real = real);
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
   * The first `count` segments walked from `base`, each lstat'd: a real folder, never a link (ESCAPE). One that is not
   * there is NOT_FOUND, or with `make` it is made, and the folder above it synced. A file in the way is NOT_FOUND, or
   * EXISTS with `make`. Gives the absolute path of the last folder walked.
   */
  async #walk(base: string, segments: readonly string[], count: number, path: string, make: boolean): Promise<string> {
    let at = base;
    for (let i = 0; i < count; i++) {
      const parent = at;
      at = join(at, segments[i]!);
      let stats = await lstatOrNot(at).catch((error: unknown) => { throw failed(error, path); });
      if (stats === undefined && make) {
        try {
          await makeDir(at, 0o777);
          await syncDir(parent);
        } catch (error) {
          if (errno(error) !== "EEXIST") throw failed(error, path);
        }
        stats = await lstatOrNot(at).catch((error: unknown) => { throw failed(error, path); });
      }
      const part = segments.slice(0, i + 1).join("/");
      if (stats === undefined) throw new WorkspaceError("NOT_FOUND", `${show(part)} is not there`, { path });
      if (stats.isSymbolicLink()) throw new WorkspaceError("ESCAPE", `${show(part)} is a symbolic link, and a workspace follows none`, { path });
      if (!stats.isDirectory()) throw new WorkspaceError(make ? "EXISTS" : "NOT_FOUND", `${show(part)} is not a directory`, { path });
    }
    return at;
  }

  /** On Linux, what `handle` opened is inside the root: a folder swapped for a link after the walk is ESCAPE. */
  static async #inside(base: string, handle: FileHandle, path: string): Promise<void> {
    if (process.platform !== "linux") return;
    const opened = (await readlink(`/proc/self/fd/${handle.fd}`)).replace(/ \(deleted\)$/, "");
    if (!opened.startsWith(`${base}/`)) throw new WorkspaceError("ESCAPE", `${show(path)} led outside the workspace's folder`, { path });
  }

  async read(path: string, range?: { readonly offset?: number; readonly length?: number }): Promise<Uint8Array> {
    const offset = range?.offset ?? 0;
    const length = range?.length;
    if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) {
      throw new WorkspaceError("REFUSED", "a read's offset and length are whole numbers, 0 or more", { path });
    }
    if (length !== undefined && length > READ_MAX) throw new WorkspaceError("TOO_LARGE", `a read returns at most ${READ_MAX} bytes`, { path });
    const segments = LocalWorkspace.#below(path, "a file");
    const base = await this.#base();
    const dir = await this.#walk(base, segments, segments.length - 1, path, false);
    let handle: FileHandle;
    try {
      handle = await open(join(dir, segments.at(-1)!), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      throw failed(error, path);
    }
    try {
      await LocalWorkspace.#inside(base, handle, path);
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
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = bytesOf(data);
    const segments = LocalWorkspace.#below(path, "a file");
    const base = await this.#base();
    const dir = await this.#walk(base, segments, segments.length - 1, path, true);
    const target = join(dir, segments.at(-1)!);
    try {
      const existing = await lstatOrNot(target);
      if (existing?.isSymbolicLink()) throw new WorkspaceError("ESCAPE", `${show(path)} is a symbolic link, and a workspace follows none`, { path });
      if (existing !== undefined && !existing.isFile()) throw new WorkspaceError("REFUSED", `${show(path)} is ${existing.isDirectory() ? "a directory" : "not a file"}`, { path });
      const temp = join(dir, `.workspace-${randomBytes(8).toString("hex")}.tmp`);
      const handle = await open(temp, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o666);
      try {
        await LocalWorkspace.#inside(base, handle, path);
        if (existing !== undefined) await handle.chmod(existing.mode & 0o777);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        await rename(temp, target);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      await syncDir(dir);
    } catch (error) {
      throw failed(error, path);
    }
  }

  async append(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = bytesOf(data);
    const segments = LocalWorkspace.#below(path, "a file");
    const base = await this.#base();
    const dir = await this.#walk(base, segments, segments.length - 1, path, true);
    const target = join(dir, segments.at(-1)!);
    try {
      let made = false;
      let handle: FileHandle;
      try {
        handle = await open(target, O_RDWR | O_APPEND | O_NOFOLLOW | O_NONBLOCK);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
        try {
          handle = await open(target, O_RDWR | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW, 0o666);
          made = true;
        } catch (again) {
          if (errno(again) !== "EEXIST") throw again;
          handle = await open(target, O_RDWR | O_APPEND | O_NOFOLLOW | O_NONBLOCK);
        }
      }
      try {
        await LocalWorkspace.#inside(base, handle, path);
        if (!(await handle.stat()).isFile()) throw new WorkspaceError("REFUSED", `${show(path)} is not a file`, { path });
        await handle.writeFile(bytes);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      if (made) await syncDir(dir);
    } catch (error) {
      throw failed(error, path);
    }
  }

  /** The absolute path of directory `path` ("" for the root), every part checked. */
  async #dir(path: string): Promise<string> {
    const segments = relativeSegments(path);
    const base = await this.#base();
    const parent = await this.#walk(base, segments, Math.max(0, segments.length - 1), path, false);
    if (segments.length === 0) return parent;
    const at = join(parent, segments.at(-1)!);
    const stats = await lstatOrNot(at).catch((error: unknown) => { throw failed(error, path); });
    if (stats === undefined) throw new WorkspaceError("NOT_FOUND", `${show(path)} is not there`, { path });
    if (stats.isSymbolicLink()) throw new WorkspaceError("ESCAPE", `${show(path)} is a symbolic link, and a workspace follows none`, { path });
    if (!stats.isDirectory()) throw new WorkspaceError("REFUSED", `${show(path)} is not a directory`, { path });
    return at;
  }

  async list(dir: string): Promise<Entry[]> {
    const at = await this.#dir(dir);
    try {
      const names = await readdir(at);
      const entries = await Promise.all(names.map(async (name): Promise<Entry | undefined> => {
        const stats = await lstatOrNot(join(at, name));
        if (stats?.isDirectory()) return { name, kind: "dir", size: 0 };
        if (stats?.isFile()) return { name, kind: "file", size: stats.size };
        return undefined;
      }));
      return entries.filter((entry): entry is Entry => entry !== undefined).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (error) {
      throw failed(error, dir);
    }
  }

  async mkdir(dir: string): Promise<void> {
    const segments = relativeSegments(dir);
    await this.#walk(await this.#base(), segments, segments.length, dir, true);
  }

  async grep(pattern: string, options: GrepOptions = {}): Promise<GrepResult> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      throw new WorkspaceError("REFUSED", `${JSON.stringify(pattern)} is not a regex: ${(error as Error).message}`, { cause: error });
    }
    const max = options.max ?? GREP_MAX;
    if (!Number.isSafeInteger(max) || max < 1) throw new WorkspaceError("REFUSED", "grep's max is a whole number, 1 or more");
    const limit = Math.min(max, GREP_MAX);
    const glob = options.glob === undefined ? undefined : { regex: globRegex(options.glob), whole: options.glob.includes("/") };
    const from = options.path ?? "";
    const segments = relativeSegments(from);
    const base = await this.#base();
    const deadline = Date.now() + GREP_TIME_MS;
    const matches: GrepMatch[] = [];
    let truncated: GrepResult["truncated"] = false;

    const searchFile = async (abs: string, rel: string, name: string): Promise<void> => {
      if (glob && !glob.regex.test(glob.whole ? rel : name)) return;
      let handle: FileHandle;
      try {
        handle = await open(abs, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      } catch {
        return;
      }
      let content: Buffer;
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > GREP_FILE_MAX) return;
        await LocalWorkspace.#inside(base, handle, rel);
        content = await handle.readFile();
      } catch {
        return;
      } finally {
        await handle.close();
      }
      if (content.subarray(0, BINARY_PROBE).includes(0)) return;
      const lines = content.toString("utf8").split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.endsWith("\r") ? lines[i]!.slice(0, -1) : lines[i]!;
        if (!regex.test(line)) continue;
        if (matches.length === limit) { truncated = "max"; return; }
        matches.push({ path: rel, line: i + 1, text: line.length > GREP_LINE_MAX ? line.slice(0, GREP_LINE_MAX) : line });
      }
    };
    const searchDir = async (abs: string, rel: string): Promise<void> => {
      let names: string[];
      try {
        names = (await readdir(abs)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      } catch {
        return;
      }
      for (const name of names) {
        if (truncated) return;
        if (Date.now() > deadline) { truncated = "time"; return; }
        const child = join(abs, name);
        const childRel = rel === "" ? name : `${rel}/${name}`;
        const stats = await lstatOrNot(child).catch(() => undefined);
        if (stats?.isDirectory()) await searchDir(child, childRel);
        else if (stats?.isFile()) await searchFile(child, childRel, name);
      }
    };

    const parent = await this.#walk(base, segments, Math.max(0, segments.length - 1), from, false);
    if (segments.length === 0) await searchDir(parent, "");
    else {
      const at = join(parent, segments.at(-1)!);
      const stats = await lstatOrNot(at).catch((error: unknown) => { throw failed(error, from); });
      const rel = segments.join("/");
      if (stats === undefined) throw new WorkspaceError("NOT_FOUND", `${show(from)} is not there`, { path: from });
      if (stats.isSymbolicLink()) throw new WorkspaceError("ESCAPE", `${show(from)} is a symbolic link, and a workspace follows none`, { path: from });
      if (stats.isDirectory()) await searchDir(at, rel);
      else if (stats.isFile()) await searchFile(at, rel, segments.at(-1)!);
    }
    return { matches, truncated };
  }

  async remove(path: string, options: { readonly recursive?: boolean; readonly force?: boolean } = {}): Promise<void> {
    const segments = relativeSegments(path);
    if (segments.length === 0) throw new WorkspaceError("REFUSED", "the workspace's root is never removed", { path: "" });
    const base = await this.#base();
    let dir: string;
    try {
      dir = await this.#walk(base, segments, segments.length - 1, path, false);
    } catch (error) {
      if (options.force && error instanceof WorkspaceError && error.code === "NOT_FOUND") return;
      throw error;
    }
    const target = join(dir, segments.at(-1)!);
    try {
      const stats = await lstatOrNot(target);
      if (stats === undefined) {
        if (options.force) return;
        throw new WorkspaceError("NOT_FOUND", `${show(path)} is not there`, { path });
      }
      if (stats.isSymbolicLink()) throw new WorkspaceError("ESCAPE", `${show(path)} is a symbolic link, and a workspace follows none`, { path });
      if (!stats.isDirectory()) await unlink(target);
      else if (options.recursive) await rm(target, { recursive: true });
      else await rmdir(target);
      await syncDir(dir);
    } catch (error) {
      throw failed(error, path);
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
    const dir = await this.#walk(await this.#base(), segments, segments.length, cwd, false);

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: dir,
        env: { ...env },
        detached: true,
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const kept = { out: 0, err: 0 };
      let truncated = false;
      let timedOut = false;
      let exit: { code: number | null } | undefined;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;

      /** Every process in its group killed: it leads its own (detached), so the group's id is its pid. */
      const killGroup = (): void => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
      };
      const keep = (into: Buffer[], which: "out" | "err") => (chunk: Buffer): void => {
        const room = cap - kept[which];
        if (chunk.length > room) truncated = true;
        if (room <= 0) return;
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        into.push(part);
        kept[which] += part.length;
      };
      const finish = (): void => {
        if (settled || exit === undefined) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), code: exit.code, timedOut, truncated });
      };
      const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);

      child.stdout!.on("data", keep(out, "out"));
      child.stderr!.on("data", keep(err, "err"));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killGroup();
        const code = errno(error);
        reject(code === "ENOENT" ? new WorkspaceError("NOT_FOUND", `${JSON.stringify(argv[0])} is not a program here (PATH ${JSON.stringify(env.PATH ?? "")})`, { cause: error })
          : code === "EACCES" ? new WorkspaceError("REFUSED", `${JSON.stringify(argv[0])} is not executable`, { cause: error })
            : new WorkspaceError("UNAVAILABLE", `exec of ${JSON.stringify(argv[0])} failed: ${error.message}`, { cause: error }));
      });
      child.on("exit", (code) => {
        exit = { code: timedOut ? null : code };
        clearTimeout(timer);
        killGroup();
        grace = setTimeout(() => { child.stdout!.destroy(); child.stderr!.destroy(); finish(); }, PIPE_GRACE_MS);
      });
      child.on("close", finish);
      if (options.stdin !== undefined) {
        child.stdin!.on("error", () => undefined);
        child.stdin!.end(Buffer.from(options.stdin.buffer, options.stdin.byteOffset, options.stdin.byteLength));
      }
    });
  }

  async attach(_computer: unknown): Promise<unknown> {
    throw new WorkspaceError("REFUSED", "attach comes with the computer mount");
  }
}

/** A Workspace on folder `root` of this machine. The folder must be there when it is first used (else UNAVAILABLE). */
export const localWorkspace = (root: string): Workspace => new LocalWorkspace(root);
