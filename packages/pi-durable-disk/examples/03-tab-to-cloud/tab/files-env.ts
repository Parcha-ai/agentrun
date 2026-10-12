// Files with no computer: an ExecutionEnv over a WorkspaceFs (workspace.ts), with no shell. The phone mode (?phone=1) runs the agent with the robot tools
// only, and they need one thing of an environment: the workspace's files (creature/robot.json, home/skills.json). Booting Wasmer for that would cost the phone
// its memory, so the files live in the page's memory (`memoryFs`) and the workspace's changes go to this browser's copy (workspace-store.ts) as they do
// offline. Every file operation a tool can ask for works on paths under the root; `exec` and the streaming readers report that this host has no shell.
// Portable: no Node API.
import type { Context } from "@earendil-works/chord";
import { err, ExecutionError, FileError, ok, type DirReader, type ExecutionEnv, type FileInfo, type FileWatcher, type Result, type ShellExecResult, type TextLineReader, type BinaryReader } from "@earendil-works/pi-durable/env";
import type { WorkspaceFs } from "./workspace.ts";

type Node = { kind: "file"; data: Uint8Array; mtimeMs: number } | { kind: "directory"; mtimeMs: number };

/** A WorkspaceFs held in memory: what a page with no computer keeps its few files in. */
export function memoryFs(root = "/workspace"): WorkspaceFs & { readonly nodes: ReadonlyMap<string, Node> } {
  const nodes = new Map<string, Node>([[root, { kind: "directory", mtimeMs: Date.now() }]]);
  const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  const missing = (p: string) => Object.assign(new Error(`no such file or directory: ${p}`), { code: "ENOENT" });
  return {
    root,
    nodes,
    async readDir(dir) {
      const at = nodes.get(dir);
      if (!at) throw missing(dir);
      if (at.kind !== "directory") throw Object.assign(new Error(`not a directory: ${dir}`), { code: "ENOTDIR" });
      const out: { name: string; kind: "file" | "directory" }[] = [];
      for (const [p, n] of nodes) if (p !== dir && parent(p) === dir) out.push({ name: p.slice(dir.length + 1), kind: n.kind });
      return out;
    },
    async readFile(p) {
      const n = nodes.get(p);
      if (!n) throw missing(p);
      if (n.kind !== "file") throw Object.assign(new Error(`is a directory: ${p}`), { code: "EISDIR" });
      return n.data;
    },
    async writeFile(p, data, mtimeMs) {
      const up = nodes.get(parent(p));
      if (!up) throw missing(parent(p));
      if (up.kind !== "directory") throw Object.assign(new Error(`not a directory: ${parent(p)}`), { code: "ENOTDIR" });
      if (nodes.get(p)?.kind === "directory") throw Object.assign(new Error(`is a directory: ${p}`), { code: "EISDIR" });
      nodes.set(p, { kind: "file", data: new Uint8Array(data), mtimeMs: mtimeMs ?? Date.now() });
    },
    async mkdir(p) {
      const n = nodes.get(p);
      if (n?.kind === "directory") return;
      if (n) throw Object.assign(new Error(`file exists: ${p}`), { code: "EEXIST" });
      if (!nodes.has(parent(p))) throw missing(parent(p));
      nodes.set(p, { kind: "directory", mtimeMs: Date.now() });
    },
    async remove(p) {
      if (!nodes.has(p)) throw missing(p);
      for (const q of [...nodes.keys()]) if (q === p || q.startsWith(`${p}/`)) nodes.delete(q);
    },
  };
}

const NO_SHELL = "this page has no computer: only the workspace's files are here (the phone runs the robot's tools, not a shell)";

const codeOf = (e: unknown): FileError["code"] => {
  const c = (e as { code?: string }).code;
  return c === "ENOENT" ? "not_found" : c === "EISDIR" ? "is_directory" : c === "ENOTDIR" ? "not_directory" : c === "EEXIST" ? "invalid" : "unknown";
};

/** The environment over `fs`: relative paths resolve against the root, and a path that leaves it is refused. */
export class FilesEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly fs: WorkspaceFs;

  constructor(fs: WorkspaceFs, id = "files") {
    this.fs = fs;
    this.id = id;
    this.cwd = fs.root;
  }

  /** The absolute path of `path`, normalized, or why not: it is outside the root. */
  private resolve(path: string): Result<string, FileError> {
    const parts: string[] = [];
    for (const part of (path.startsWith("/") ? path : `${this.cwd}/${path}`).split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    const abs = `/${parts.join("/")}`;
    const root = this.fs.root;
    return abs === root || abs.startsWith(`${root}/`) ? ok(abs) : err(new FileError("permission_denied", `${path} is outside the workspace (${root})`, path));
  }

  private async guard<T>(path: string, context: Context, run: (abs: string) => Promise<T>): Promise<Result<T, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
    const r = this.resolve(path);
    if (!r.ok) return r;
    try {
      return ok(await run(r.value));
    } catch (e) {
      return err(new FileError(codeOf(e), (e as Error).message, r.value));
    }
  }

  private async mkdirs(abs: string): Promise<void> {
    const root = this.fs.root;
    let at = root;
    for (const part of abs.slice(root.length + 1).split("/").filter(Boolean)) {
      at = `${at}/${part}`;
      await this.fs.mkdir(at);
    }
  }

  private async info(abs: string): Promise<FileInfo> {
    const name = abs.slice(abs.lastIndexOf("/") + 1);
    const dir = abs.slice(0, abs.lastIndexOf("/")) || "/";
    if (abs === this.fs.root) return { name, path: abs, kind: "directory", size: 0, mtimeMs: 0 };
    const entry = (await this.fs.readDir(dir)).find((e) => e.name === name);
    if (!entry || entry.kind === "other") throw Object.assign(new Error(`no such file or directory: ${abs}`), { code: "ENOENT" });
    return { name, path: abs, kind: entry.kind, size: entry.kind === "file" ? (await this.fs.readFile(abs)).length : 0, mtimeMs: Date.now() };
  }

  absolutePath(path: string, context: Context) { return this.guard(path, context, async (abs) => abs); }
  canonicalPath(path: string, context: Context) { return this.guard(path, context, async (abs) => (await this.info(abs), abs)); }
  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> { return ok(parts.join("/").replace(/\/+/g, "/")); }
  readBinaryFile(path: string, context: Context) { return this.guard(path, context, (abs) => this.fs.readFile(abs)); }
  readTextFile(path: string, context: Context) { return this.guard(path, context, async (abs) => new TextDecoder().decode(await this.fs.readFile(abs))); }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
    return this.guard(path, context, async (abs) => {
      const lines = new TextDecoder().decode(await this.fs.readFile(abs)).split("\n");
      if (lines.at(-1) === "") lines.pop();
      return options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines);
    });
  }
  writeFile(path: string, content: string | Uint8Array, context: Context) {
    return this.guard(path, context, async (abs) => {
      await this.mkdirs(abs.slice(0, abs.lastIndexOf("/")));
      await this.fs.writeFile(abs, typeof content === "string" ? new TextEncoder().encode(content) : content);
      this.fs.touched?.(abs);
    });
  }
  appendFile(path: string, content: string | Uint8Array, context: Context) {
    return this.guard(path, context, async (abs) => {
      const have = await this.fs.readFile(abs).catch(() => new Uint8Array());
      const more = typeof content === "string" ? new TextEncoder().encode(content) : content;
      const next = new Uint8Array(have.length + more.length);
      next.set(have);
      next.set(more, have.length);
      await this.mkdirs(abs.slice(0, abs.lastIndexOf("/")));
      await this.fs.writeFile(abs, next);
      this.fs.touched?.(abs);
    });
  }
  truncateFile(path: string, size: number, context: Context) {
    return this.guard(path, context, async (abs) => {
      const have = await this.fs.readFile(abs);
      const next = new Uint8Array(size);
      next.set(have.subarray(0, size));
      await this.fs.writeFile(abs, next);
      this.fs.touched?.(abs);
    });
  }
  flushFile(path: string, context: Context) { return this.guard(path, context, async () => undefined); }
  renameFile(sourcePath: string, destinationPath: string, context: Context) {
    return this.guard(sourcePath, context, async (from) => {
      const to = this.resolve(destinationPath);
      if (!to.ok) throw Object.assign(new Error(to.error.message), { code: "EACCES" });
      const data = await this.fs.readFile(from);
      await this.mkdirs(to.value.slice(0, to.value.lastIndexOf("/")));
      await this.fs.writeFile(to.value, data);
      await this.fs.remove(from);
    });
  }
  fileInfo(path: string, context: Context) { return this.guard(path, context, (abs) => this.info(abs)); }
  listDir(path: string, context: Context) {
    return this.guard(path, context, async (abs) => {
      const out: FileInfo[] = [];
      for (const e of await this.fs.readDir(abs)) if (e.kind !== "other") out.push(await this.info(`${abs}/${e.name}`));
      return out;
    });
  }
  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.guard(path, context, async (abs) => {
      let left: FileInfo[] | undefined;
      const reader: DirReader = {
        next: async (maxEntries) => {
          if (!left) left = await this.listDir(abs, context).then((r) => (r.ok ? r.value : []));
          const all: FileInfo[] = left ?? [];
          const entries = all.splice(0, Math.max(1, maxEntries));
          return ok({ entries, done: all.length === 0 });
        },
        close: async () => undefined,
      };
      return reader;
    });
  }
  exists(path: string, context: Context) {
    return this.guard(path, context, async (abs) => this.info(abs).then(() => true, () => false));
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.guard(path, context, async (abs) => {
      if (options?.recursive) await this.mkdirs(abs);
      else await this.fs.mkdir(abs);
    });
  }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
    return this.guard(path, context, async (abs) => {
      if (abs === this.fs.root) throw Object.assign(new Error("the workspace's root is not removed"), { code: "EACCES" });
      const info = await this.info(abs).catch((e: unknown) => { if (options?.force && codeOf(e) === "not_found") return undefined; throw e; });
      if (!info) return;
      if (info.kind === "directory" && !options?.recursive && (await this.fs.readDir(abs)).length > 0) throw Object.assign(new Error(`directory not empty: ${abs}`), { code: "ENOTEMPTY" });
      await this.fs.remove(abs);
    });
  }
  async openTextLineReader(path: string): Promise<Result<TextLineReader, FileError>> { return err(new FileError("not_supported", NO_SHELL, path)); }
  async openBinaryReader(path: string): Promise<Result<BinaryReader, FileError>> { return err(new FileError("not_supported", NO_SHELL, path)); }
  async watch(): Promise<Result<FileWatcher, FileError>> { return err(new FileError("not_supported", NO_SHELL)); }
  async createTempDir(): Promise<Result<string, FileError>> { return err(new FileError("not_supported", NO_SHELL)); }
  async createTempFile(): Promise<Result<string, FileError>> { return err(new FileError("not_supported", NO_SHELL)); }
  async exec(_command: string | readonly string[], _options?: unknown, _context?: Context): Promise<Result<ShellExecResult, ExecutionError>> { return err(new ExecutionError("shell_unavailable", NO_SHELL)); }
  async cleanup(): Promise<void> {}
}
