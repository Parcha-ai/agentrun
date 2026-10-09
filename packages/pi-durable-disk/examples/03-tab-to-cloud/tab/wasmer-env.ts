// pi's ExecutionEnv on a Wasmer sandbox: the agent's hands in the tab. Commands run as WASIX processes (bash, coreutils,
// node from `wasmer/edgejs`); files live in the sandbox's /workspace, which page JavaScript reads and writes directly, so
// the write-through can diff it after a tool. Portable: the same class runs on the browser SDK and on the Node SDK
// (tests); it needs only a `Sandbox`.
//
// Invariants:
// - Every path resolves under /workspace; anything else is `not_found` (the sandbox has nothing else that persists).
// - The sandbox's file API has no modification times and no symbolic links; mtimes are the times this env (or the
//   write-through scan) saw a file change, and canonical paths are the normalized paths.
// - Temporary files and output spills go to /workspace/.pi-tmp, which the write-through never sends: they belong to the
//   tab, as /tmp belongs to a host.
import { err, ExecutionError, FileError, LineScanner, ok } from "@earendil-works/pi-durable/env";
import type {
  BinaryReader,
  DirReader,
  ExecutionEnv,
  FileInfo,
  FileWatcher,
  Result,
  ShellExecOptions,
  ShellExecResult,
  TextLineReader,
  WatchChange,
  WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";

/** The part of a Wasmer `Sandbox` this env uses (the browser and Node SDKs share it). */
export interface WasmerSandbox {
  readonly fs: {
    writeFile(path: string, contents: string | Uint8Array): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    readText(path: string): Promise<string>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readDir(path: string): Promise<readonly { name: string; kind: "file" | "directory"; size: number }[]>;
    stat(path: string): Promise<{ kind: "file" | "directory"; size: number }>;
    remove(path: string, options?: { recursive?: boolean }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
  };
  shell(script: string, options?: { cwd?: string; env?: Readonly<Record<string, string>> }): WasmerCommand;
  command(selector: string, args?: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): WasmerCommand;
}
export interface WasmerCommand {
  spawn(options?: { timeoutMs?: number; stdin?: "pipe" | "closed"; stdout?: "pipe"; stderr?: "pipe" }): Promise<WasmerProcess>;
}
export interface WasmerProcess {
  readonly stdout: AsyncIterable<Uint8Array> | null;
  readonly stderr: AsyncIterable<Uint8Array> | null;
  wait(options?: { check?: boolean }): Promise<{ exitCode: number; reason: "exited" | "terminated" | "timeout" }>;
  kill(): Promise<void>;
}

export const WORKSPACE = "/workspace";
/** The tab's temporary files: under the workspace (the only place that persists in the sandbox), never synced. */
export const TAB_TMP = ".pi-tmp";
/** As pi's Node environment: the largest timer delay, in seconds. */
const MAX_TIMEOUT_S = 2_147_483_647 / 1000;

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

const isAbort = (context: Context) => context.abortSignal?.aborted === true;
const aborted = <T>(path?: string): Result<T, FileError> => err(new FileError("aborted", "Operation aborted", path));

function fileError(error: unknown, path: string): FileError {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|No such file|does not exist/i.test(message)) return new FileError("not_found", `${path}: not found`, path, error as Error);
  if (/is a directory/i.test(message)) return new FileError("is_directory", `${path}: is a directory`, path, error as Error);
  if (/not a directory/i.test(message)) return new FileError("not_directory", `${path}: not a directory`, path, error as Error);
  if (/permission|denied/i.test(message)) return new FileError("permission_denied", `${path}: permission denied`, path, error as Error);
  return new FileError("unknown", `${path}: ${message}`, path, error as Error);
}

const encoder = new TextEncoder();

export interface WasmerEnvOptions {
  /** The file namespace id (pi serializes writes per id and path); one per run. */
  readonly id: string;
  /** Base environment of every command. */
  readonly env?: Readonly<Record<string, string>>;
  readonly now?: () => number;
}

export class WasmerEnv implements ExecutionEnv {
  readonly id: string;
  cwd = WORKSPACE;
  readonly sandbox: WasmerSandbox;
  #env: Readonly<Record<string, string>>;
  #now: () => number;
  #mtimes = new Map<string, number>();
  #running = new Set<WasmerProcess>();
  #closed = false;
  #temp = 0;

  constructor(sandbox: WasmerSandbox, options: WasmerEnvOptions) {
    this.sandbox = sandbox;
    this.id = options.id;
    this.#env = options.env ?? {};
    this.#now = options.now ?? Date.now;
  }

  /** Absolute and normalized; null when outside the workspace. */
  #path(path: string, cwd = this.cwd): string | null {
    const abs = normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
    return abs === WORKSPACE || abs.startsWith(`${WORKSPACE}/`) ? abs : null;
  }

  /** Record that the env saw `path` change now (the sandbox's stat has no mtime). */
  touch(path: string, at = this.#now()): void {
    this.#mtimes.set(path, at);
  }

  mtime(path: string): number {
    return this.#mtimes.get(path) ?? 0;
  }

  async #info(abs: string): Promise<FileInfo> {
    const stat = await this.sandbox.fs.stat(abs);
    return { name: abs.split("/").pop() || "/", path: abs, kind: stat.kind, size: stat.size, mtimeMs: this.mtime(abs) };
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(normalize(path.startsWith("/") ? path : `${this.cwd}/${path}`));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    const joined = parts.reduce((acc, part) => (part.startsWith("/") ? part : acc === "" ? part : `${acc}/${part}`), "");
    return ok(joined.startsWith("/") ? normalize(joined) : normalize(joined).slice(1) || ".");
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    if (isAbort(context)) return aborted(path);
    const abs = this.#path(path);
    if (abs === null) return err(new FileError("not_found", `${path}: outside the workspace`, path));
    try {
      await this.sandbox.fs.stat(abs);
      return ok(abs);
    } catch (error) {
      return err(fileError(error, path));
    }
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const bytes = await this.readBinaryFile(path, context);
    return bytes.ok ? ok(new TextDecoder().decode(bytes.value)) : bytes;
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    if (isAbort(context)) return aborted(path);
    const abs = this.#path(path);
    if (abs === null) return err(new FileError("not_found", `${path}: outside the workspace`, path));
    try {
      const stat = await this.sandbox.fs.stat(abs);
      if (stat.kind === "directory") return err(new FileError("is_directory", `${path}: is a directory`, path));
      return ok(await this.sandbox.fs.readFile(abs));
    } catch (error) {
      return err(fileError(error, path));
    }
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(path, context);
    if (!text.ok) return text;
    const parts = text.value.split("\n");
    let i = 0;
    return ok({
      async readLine() {
        if (i >= parts.length || (i === parts.length - 1 && parts[i] === "")) return ok(undefined);
        const line = parts[i]!;
        const terminated = i < parts.length - 1;
        i++;
        return ok({ text: line, terminated });
      },
      async close() {},
    });
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(path, context);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const bytes = await this.readBinaryFile(path, context);
    if (!bytes.ok) return bytes;
    const abs = this.#path(path)!;
    // The file as it was when opened: every call sees the same bytes, whatever later happens at its path.
    const data = bytes.value;
    const info: FileInfo = { name: abs.split("/").pop()!, path: abs, kind: "file", size: data.length, mtimeMs: this.mtime(abs) };
    let closed = false;
    const refuse = (context: Context) =>
      closed ? err<never, FileError>(new FileError("invalid", "Binary reader is closed", abs)) : isAbort(context) ? aborted<never>(abs) : undefined;
    return ok({
      async info(context) {
        return refuse(context) ?? ok(info);
      },
      async read(offset, length, context) {
        const refused = refuse(context);
        if (refused) return refused;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) return err(new FileError("invalid", "Invalid byte range", abs));
        return ok(data.slice(offset, offset + length));
      },
      async scanLines(options, context) {
        const refused = refuse(context);
        if (refused) return refused;
        let scanner: LineScanner;
        try {
          scanner = new LineScanner(options.startLine, options.endLine);
        } catch {
          return err(new FileError("invalid", "Invalid line range", abs));
        }
        scanner.push(data);
        return ok(scanner.finish());
      },
      async close() {
        closed = true;
      },
    });
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    if (isAbort(context)) return aborted(path);
    const abs = this.#path(path);
    if (abs === null) return err(new FileError("permission_denied", `${path}: outside the workspace`, path));
    try {
      const parent = abs.slice(0, abs.lastIndexOf("/")) || "/";
      if (parent !== WORKSPACE) await this.sandbox.fs.mkdir(parent, { recursive: true });
      await this.sandbox.fs.writeFile(abs, typeof content === "string" ? encoder.encode(content) : content);
      this.touch(abs);
      return ok(undefined);
    } catch (error) {
      return err(fileError(error, path));
    }
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const current = await this.readBinaryFile(path, context);
    if (!current.ok && current.error.code !== "not_found") return current;
    const extra = typeof content === "string" ? encoder.encode(content) : content;
    const base = current.ok ? current.value : new Uint8Array();
    const next = new Uint8Array(base.length + extra.length);
    next.set(base);
    next.set(extra, base.length);
    return this.writeFile(path, next, context);
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const current = await this.readBinaryFile(path, context);
    if (!current.ok) return current;
    const next = new Uint8Array(size);
    next.set(current.value.subarray(0, Math.min(size, current.value.length)));
    return this.writeFile(path, next, context);
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const exists = await this.exists(path, context);
    if (!exists.ok) return exists;
    return exists.value ? ok(undefined) : err(new FileError("not_found", `${path}: not found`, path));
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    if (isAbort(context)) return aborted(sourcePath);
    const from = this.#path(sourcePath);
    const to = this.#path(destinationPath);
    if (from === null || to === null) return err(new FileError("permission_denied", "rename outside the workspace", sourcePath));
    try {
      await this.sandbox.fs.rename(from, to);
      this.touch(to);
      return ok(undefined);
    } catch (error) {
      return err(fileError(error, sourcePath));
    }
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    if (isAbort(context)) return aborted(path);
    const abs = this.#path(path);
    if (abs === null) return err(new FileError("not_found", `${path}: outside the workspace`, path));
    try {
      return ok(await this.#info(abs));
    } catch (error) {
      return err(fileError(error, path));
    }
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    if (isAbort(context)) return aborted(path);
    const abs = this.#path(path);
    if (abs === null) return err(new FileError("not_found", `${path}: outside the workspace`, path));
    try {
      const stat = await this.sandbox.fs.stat(abs);
      if (stat.kind !== "directory") return err(new FileError("not_directory", `${path}: not a directory`, path));
      const entries = await this.sandbox.fs.readDir(abs);
      return ok(entries.map((e) => {
        const child = `${abs === "/" ? "" : abs}/${e.name}`;
        return { name: e.name, path: child, kind: e.kind, size: e.size, mtimeMs: this.mtime(child) };
      }));
    } catch (error) {
      return err(fileError(error, path));
    }
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const listed = await this.listDir(path, context);
    if (!listed.ok) return listed;
    const entries = listed.value;
    let at = 0;
    let closed = false;
    const fs = this.sandbox.fs;
    return ok({
      async next(maxEntries, context) {
        if (closed) return err(new FileError("invalid", "Directory reader is closed", path));
        if (isAbort(context)) return aborted(path);
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) return err(new FileError("invalid", "maxEntries must be a positive integer", path));
        const page: FileInfo[] = [];
        while (page.length < maxEntries && at < entries.length) {
          const entry = entries[at++]!;
          // An entry removed since the listing is skipped, as a live enumeration would not see it.
          const stat = await fs.stat(entry.path).catch(() => null);
          if (stat) page.push({ ...entry, kind: stat.kind, size: stat.size });
        }
        return ok({ entries: page, done: at >= entries.length });
      },
      async close() {
        closed = true;
      },
    });
  }

  /** Polling: the sandbox reports no changes. Compares listings every second. */
  async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    const signature = async (): Promise<Map<string, string>> => {
      const out = new Map<string, string>();
      for (const target of targets) {
        const abs = this.#path(target.path);
        if (abs === null) continue;
        const walk = async (dir: string, depth: number): Promise<void> => {
          const listed = await this.listDir(dir, context);
          if (!listed.ok) {
            out.set(dir, "missing");
            return;
          }
          for (const e of listed.value) {
            if (target.exclude?.hidden && e.name.startsWith(".")) continue;
            if (target.exclude?.names?.includes(e.name)) continue;
            out.set(e.path, `${e.kind}:${e.size}:${e.mtimeMs}`);
            if (e.kind === "directory" && target.recursive && depth < 32) await walk(e.path, depth + 1);
          }
        };
        const info = await this.fileInfo(abs, context);
        if (!info.ok) out.set(abs, "missing");
        else if (info.value.kind === "directory") await walk(abs, 0);
        else out.set(abs, `file:${info.value.size}:${info.value.mtimeMs}`);
      }
      return out;
    };
    let last = await signature();
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped) return;
      const next = await signature();
      const changed = new Set<string>();
      for (const [k, v] of next) if (last.get(k) !== v) changed.add(k);
      for (const k of last.keys()) if (!next.has(k)) changed.add(k);
      // The listing has no directory identities, so a directory replaced at its path shows only through its entries:
      // report each changed entry's directory too (a directory path covers its subtree; a spurious call is allowed).
      for (const k of [...changed]) {
        const parent = k.slice(0, k.lastIndexOf("/"));
        if (parent.startsWith(WORKSPACE)) changed.add(parent);
      }
      last = next;
      if (changed.size > 0 && !stopped) onChange({ paths: [...changed] });
    }, 1_000);
    return ok({
      mode: "polling" as const,
      async close() {
        stopped = true;
        clearInterval(timer);
      },
    });
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    if (isAbort(context)) return aborted(path);
    const abs = this.#path(path);
    if (abs === null) return ok(false);
    try {
      await this.sandbox.fs.stat(abs);
      return ok(true);
    } catch (error) {
      const fe = fileError(error, path);
      return fe.code === "not_found" ? ok(false) : err(fe);
    }
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    if (isAbort(context)) return aborted(path);
    const abs = this.#path(path);
    if (abs === null) return err(new FileError("permission_denied", `${path}: outside the workspace`, path));
    try {
      await this.sandbox.fs.mkdir(abs, { recursive: options?.recursive === true });
      return ok(undefined);
    } catch (error) {
      return err(fileError(error, path));
    }
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    if (isAbort(context)) return aborted(path);
    const abs = this.#path(path);
    if (abs === null || abs === WORKSPACE) return err(new FileError("permission_denied", `${path}: cannot remove`, path));
    try {
      await this.sandbox.fs.remove(abs, { recursive: options?.recursive === true });
      this.#mtimes.delete(abs);
      return ok(undefined);
    } catch (error) {
      const fe = fileError(error, path);
      return fe.code === "not_found" && options?.force ? ok(undefined) : err(fe);
    }
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const dir = `${WORKSPACE}/${TAB_TMP}/${prefix ?? "tmp-"}${this.#now().toString(36)}${++this.#temp}`;
    const made = await this.createDir(dir, { recursive: true }, context);
    return made.ok ? ok(dir) : made;
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir("tmp-", context);
    if (!dir.ok) return dir;
    const file = `${dir.value}/${options?.prefix ?? ""}${++this.#temp}${options?.suffix ?? ""}`;
    const written = await this.writeFile(file, "", context);
    return written.ok ? ok(file) : written;
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (this.#closed) return err(new ExecutionError("aborted", "the environment is closed"));
    if (isAbort(context)) return err(new ExecutionError("aborted", "Command aborted"));
    let timeoutMs: number | undefined;
    if (options?.timeout !== undefined) {
      if (!Number.isFinite(options.timeout) || options.timeout <= 0) return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
      if (options.timeout > MAX_TIMEOUT_S) return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_S} seconds`));
      timeoutMs = options.timeout * 1000;
    }
    const cwd = options?.cwd === undefined ? this.cwd : this.#path(options.cwd);
    if (cwd === null) return err(new ExecutionError("spawn_error", `cwd ${options?.cwd} is outside the workspace`));
    const env = { ...(options?.inheritEnv === false ? {} : this.#env), ...(options?.env ?? {}) };
    const built = typeof command === "string" ? this.sandbox.shell(command, { cwd, env }) : this.sandbox.command(command[0]!, command.slice(1), { cwd, env });
    let proc: WasmerProcess;
    try {
      proc = await built.spawn({ stdin: "closed", stdout: "pipe", stderr: "pipe", ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    } catch (error) {
      return err(new ExecutionError("spawn_error", error instanceof Error ? error.message : String(error), error as Error));
    }
    this.#running.add(proc);
    const onAbort = () => void proc.kill().catch(() => undefined);
    context.abortSignal?.addEventListener("abort", onAbort, { once: true });
    // Output spills to a file once it crosses either threshold; the caller then reads the file for the whole output.
    let spillPath: string | undefined;
    let spilled = "";
    let bytes = 0;
    let lines = 0;
    const spill = options?.spill;
    const pump = async (stream: AsyncIterable<Uint8Array> | null, name: "stdout" | "stderr") => {
      if (!stream) return;
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        if (text === "") continue;
        bytes += chunk.length;
        for (const c of text) if (c === "\n") lines++;
        spilled += text;
        if (spill && spillPath === undefined && (bytes > spill.afterBytes || lines > spill.afterLines)) spillPath = "";
        try {
          options?.onOutput?.(text, context, { stream: name });
        } catch {
          // A throwing callback must not stop the command's output.
        }
      }
      const tail = decoder.decode();
      if (tail) options?.onOutput?.(tail, context, { stream: name });
    };
    let result: { exitCode: number; reason: string };
    try {
      [result] = await Promise.all([proc.wait({ check: false }), pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
    } catch (error) {
      result = { exitCode: 137, reason: isAbort(context) ? "terminated" : "error" };
      void error;
    } finally {
      this.#running.delete(proc);
      context.abortSignal?.removeEventListener("abort", onAbort);
    }
    if (spillPath !== undefined) {
      const file = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, context);
      if (file.ok) {
        await this.sandbox.fs.writeFile(file.value, encoder.encode(spilled));
        spillPath = file.value;
      } else spillPath = undefined;
    }
    if (isAbort(context) || result.reason === "terminated") {
      const error = new ExecutionError("aborted", "Command aborted");
      if (spillPath) error.spillPath = spillPath;
      return err(error);
    }
    if (result.reason === "timeout") {
      const error = new ExecutionError("timeout", `Command timed out after ${options?.timeout} seconds`);
      if (spillPath) error.spillPath = spillPath;
      return err(error);
    }
    return ok({ exitCode: result.exitCode, ...(spillPath ? { spillPath } : {}) });
  }

  async cleanup(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#running].map((p) => p.kill()));
    this.#running.clear();
  }
}

/** The tab's workspace files, for Workspace (workspace.ts): the sandbox's /workspace, its times kept by `env`. */
export function wasmerWorkspaceFs(env: WasmerEnv): import("./workspace.ts").WorkspaceFs {
  const fs = env.sandbox.fs;
  return {
    root: WORKSPACE,
    skip: TAB_TMP,
    readDir: async (dir) => (await fs.readDir(dir)).map((e) => ({ name: e.name, kind: e.kind })),
    readFile: (path) => fs.readFile(path),
    async writeFile(path, data, mtimeMs) {
      await fs.writeFile(path, data);
      env.touch(path, mtimeMs);
    },
    mkdir: (path) => fs.mkdir(path, { recursive: true }),
    remove: (path) => fs.remove(path, { recursive: true }),
    touched: (path) => env.touch(path),
  };
}
