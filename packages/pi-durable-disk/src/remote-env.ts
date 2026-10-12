// RemoteEnv: pi's ExecutionEnv over a remote sandbox's exec API (a Modal sandbox with a GPU, for one thread of a session). The
// session, its store and its model calls stay on the host; only the thread's tools run on the box: every file operation and
// every command is one bounded remote exec of a fixed script, its paths passed as arguments (never spliced into the script).
//
// Failure is a tool error the thread can see, never a hang:
//   - every remote call has a deadline (file operations `opTimeoutMs`; a command its own timeout, else `maxExecMs`) and
//     honours the caller's abort, which kills the command's whole process group on the box;
//   - a box that ended (poll() reports its exit) or stops answering is marked lost, and from then on every call fails at once
//     with "the box ... is gone (...)". The state is the env's, so a thread sees the same answer on every tool.
//
// ArtifactSync copies what a thread's programs write on the box (checkpoints) back to the session's disk while the box lives:
// new and changed files, in modification order, each written whole (a temporary file renamed into place), so a reader on the
// session's side never sees half a checkpoint. `remoteEnvs` is the HarnessOptions.env for a session whose threads have boxes.
import { mkdir, open, rename, rm, stat, utimes } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join as joinLocal } from "node:path";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, ExecutionError, FileError, LineScanner, ok, StreamDecoder, startsWithBom } from "@earendil-works/pi-durable/env";
import type {
  BinaryReader,
  DirReader,
  ExecutionEnv,
  FileErrorCode,
  FileInfo,
  FileKind,
  FileWatcher,
  Result,
  ShellExecOptions,
  ShellExecResult,
  TextLineReader,
  WatchChange,
  WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { EnvTarget } from "@earendil-works/pi-durable";

// ---- the box ----------------------------------------------------------------------------------------------------------------

/** A stream of one remote process: a WHATWG ReadableStream or any async iterable of chunks (Modal's streams are both). */
export type RemoteStream = AsyncIterable<Uint8Array> | { getReader(): ReadableStreamDefaultReader<Uint8Array> };

export interface RemoteProcess {
  stdin: { writeBytes(bytes: Uint8Array): Promise<void>; close(): Promise<void> };
  stdout: RemoteStream;
  stderr: RemoteStream;
  wait(): Promise<number>;
}

/** The part of a sandbox the environment drives. A Modal Sandbox satisfies it structurally. */
export interface RemoteBox {
  readonly sandboxId: string;
  exec(command: string[], params: { mode: "binary"; timeoutMs?: number }): Promise<RemoteProcess>;
  /** null while the box runs, its exit code once it has ended. */
  poll(): Promise<number | null>;
}

export interface RemoteEnvOptions {
  box: RemoteBox;
  /** The workspace on the box and the env's cwd. Default `/workspace`. */
  root?: string;
  /** The file namespace id. Default the box's id (pi serializes edits and writes per env id). */
  id?: string;
  /** Deadline of one file operation. Default 60 s. */
  opTimeoutMs?: number;
  /** Deadline of a command run without a timeout of its own. Default 30 min. */
  maxExecMs?: number;
  /** How long a liveness check may take before the box counts as not answering. Default 10 s. */
  pollTimeoutMs?: number;
  /** The watcher's polling interval. Default 1 s. */
  watchIntervalMs?: number;
}

/** Thrown inside the env when a call cannot complete; turned into the operation's FileError or ExecutionError. */
class BoxGone extends Error {}
class Timeout extends Error {}
/** The host could not keep a command's output for its spill file (a full disk, say): the command is stopped and the call fails. */
class SpillFailed extends Error {}

const enc = new TextEncoder();
const decoder = () => new TextDecoder();

async function* chunks(s: RemoteStream): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in s) {
    for await (const c of s as AsyncIterable<Uint8Array>) yield typeof c === "string" ? enc.encode(c) : c;
    return;
  }
  const reader = (s as { getReader(): ReadableStreamDefaultReader<Uint8Array> }).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield typeof value === "string" ? enc.encode(value) : value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function readAll(s: RemoteStream, limit = Infinity): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of chunks(s)) {
    n += c.length;
    if (n > limit) throw new FileError("invalid", `more than ${limit} bytes`);
    parts.push(c);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Resolves or rejects with `p`, or rejects with Timeout after `ms`, or with the abort reason when the context aborts. */
function bounded<T>(p: Promise<T>, ms: number, context?: Context, onAbort?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout(`no answer in ${ms} ms`)), ms);
    const signal = context?.abortSignal;
    const abort = () => { onAbort?.(); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    if (signal?.aborted) { clearTimeout(timer); abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    p.then(
      (v) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(v); },
      (e) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(e); },
    );
  });
}

const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";
/** A remote exec's own timeout: whole seconds (Modal refuses anything else). */
const seconds = (ms: number) => Math.ceil(ms / 1000) * 1000;

// Exit codes the scripts use for the file errors they report.
const CODES: Record<number, FileErrorCode> = { 3: "not_found", 4: "is_directory", 5: "not_directory", 6: "permission_denied", 7: "invalid" };
// A script prelude: `fail <code>` exits with one of CODES after classifying the path in $1 the way a stat would.
const PRELUDE = `check() { if [ ! -e "$1" ] && [ ! -L "$1" ]; then d=$(dirname -- "$1"); while [ "$d" != "/" ] && [ ! -e "$d" ]; do d=$(dirname -- "$d"); done; [ -d "$d" ] || exit 5; exit 3; fi; }\n`;

const kindOf = (y: string): FileKind | null => (y === "f" ? "file" : y === "d" ? "directory" : y === "l" ? "symlink" : null);

/** Parse `find -printf '%p\\0%y\\0%s\\0%T@\\0'` (or `%f` for the name). */
function parseFind(bytes: Uint8Array): { p: string; y: string; size: number; mtimeMs: number }[] {
  const f = decoder().decode(bytes).split("\0");
  const out: { p: string; y: string; size: number; mtimeMs: number }[] = [];
  for (let i = 0; i + 3 < f.length; i += 4) out.push({ p: f[i]!, y: f[i + 1]!, size: Number(f[i + 2]), mtimeMs: Math.round(Number(f[i + 3]) * 1000) });
  return out;
}

export class RemoteEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly box: RemoteBox;
  readonly root: string;
  private readonly opTimeoutMs: number;
  private readonly maxExecMs: number;
  private readonly pollTimeoutMs: number;
  private readonly watchIntervalMs: number;
  private lost: string | null = null;
  private seq = 0;
  private readonly running = new Set<string>();
  private readonly watchers = new Set<{ close(context: Context): Promise<void> }>();

  constructor(o: RemoteEnvOptions) {
    this.box = o.box;
    this.root = o.root ?? "/workspace";
    this.cwd = this.root;
    this.id = o.id ?? o.box.sandboxId;
    this.opTimeoutMs = o.opTimeoutMs ?? 60_000;
    this.maxExecMs = o.maxExecMs ?? 30 * 60_000;
    this.pollTimeoutMs = o.pollTimeoutMs ?? 10_000;
    this.watchIntervalMs = o.watchIntervalMs ?? 1_000;
  }

  /** "live", or why the box is gone; once gone, every call fails at once with this reason. */
  state(): "live" | { lost: string } {
    return this.lost === null ? "live" : { lost: this.lost };
  }

  private goneMessage(): string {
    return `the box ${this.box.sandboxId} is gone (${this.lost}); this thread's tools cannot run there any more`;
  }

  /** A call failed or ran out of time: find out whether the box itself is gone, and remember it if so. */
  private async diagnose(cause: unknown): Promise<void> {
    if (this.lost !== null) return;
    let exit: number | null;
    try {
      exit = await bounded(this.box.poll(), this.pollTimeoutMs);
    } catch (e) {
      this.lost = e instanceof Timeout ? `it did not answer a liveness check in ${this.pollTimeoutMs} ms` : `it cannot be reached: ${(e as Error)?.message ?? e}`;
      return;
    }
    if (exit !== null) this.lost = `it ended with exit code ${exit}`;
    else if (cause instanceof Timeout) return; // it runs; the call itself was slow
  }

  /**
   * Run `argv` on the box with `stdin`, collecting stdout (as bytes) and stderr (as text), within `ms` and the context. Throws
   * BoxGone when the box is (or turns out to be) gone, Timeout when the call ran out of time on a live box, AbortError on abort.
   */
  private async call(argv: string[], o: { stdin?: Uint8Array; ms?: number; context?: Context; limit?: number } = {}): Promise<{ code: number; out: Uint8Array; err: string }> {
    if (this.lost !== null) throw new BoxGone(this.goneMessage());
    const ms = o.ms ?? this.opTimeoutMs;
    try {
      const p = await bounded(this.box.exec(argv, { mode: "binary", timeoutMs: seconds(ms + 5_000) }), ms, o.context);
      const io = (async () => {
        if (o.stdin && o.stdin.length) await p.stdin.writeBytes(o.stdin);
        await p.stdin.close();
        const [out, errBytes, code] = await Promise.all([readAll(p.stdout, o.limit), readAll(p.stderr), p.wait()]);
        return { code, out, err: decoder().decode(errBytes) };
      })();
      return await bounded(io, ms, o.context);
    } catch (e) {
      if (isAbort(e) || e instanceof FileError) throw e;
      await this.diagnose(e);
      if (this.lost !== null) throw new BoxGone(this.goneMessage());
      if (e instanceof Timeout) throw e;
      // An exec that failed on a live box (an API hiccup): one more attempt is safe for these idempotent reads and writes.
      throw new BoxGone(`the box ${this.box.sandboxId} did not run the call: ${(e as Error)?.message ?? e}`);
    }
  }

  /** A file operation: run `script` (after PRELUDE) with `args`; map its exit code to a FileError. */
  private async file<T>(path: string, script: string, args: string[], context: Context, done: (r: { out: Uint8Array; err: string }) => T, o: { stdin?: Uint8Array; limit?: number } = {}): Promise<Result<T, FileError>> {
    try {
      const r = await this.call(["sh", "-c", PRELUDE + script, "sh", ...args], { stdin: o.stdin, context, limit: o.limit });
      if (r.code === 0) return ok(done(r));
      const code = CODES[r.code] ?? "unknown";
      return err(new FileError(code, `${code.replace("_", " ")}: ${path}${r.err.trim() ? ` (${r.err.trim().slice(-200)})` : ""}`, path));
    } catch (e) {
      return err(this.fileError(e, path));
    }
  }

  private fileError(e: unknown, path: string): FileError {
    if (e instanceof FileError) return e;
    if (isAbort(e)) return new FileError("aborted", `aborted: ${path}`, path);
    if (e instanceof Timeout) return new FileError("unknown", `the box ${this.box.sandboxId} did not finish the file operation in ${this.opTimeoutMs} ms: ${path}`, path);
    return new FileError("unknown", (e as Error)?.message ?? String(e), path);
  }

  private abs(path: string): string {
    return posix.resolve(this.cwd, path);
  }

  // ---- paths
  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.abs(path));
  }
  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }
  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const p = this.abs(path);
    return this.file(p, `check "$1"; realpath -e -- "$1"`, [p], context, (r) => decoder().decode(r.out).replace(/\n$/, ""));
  }

  // ---- reads
  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const p = this.abs(path);
    return this.file(p, `check "$1"; [ -d "$1" ] && exit 4; [ -r "$1" ] || exit 6; cat -- "$1"`, [p], context, (r) => r.out);
  }
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const r = await this.readBinaryFile(path, context);
    return r.ok ? ok(decoder().decode(r.value)) : r;
  }
  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const r = await this.readTextFile(path, context);
    if (!r.ok) return r;
    const lines = r.value.split("\n");
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    return ok(options?.maxLines !== undefined ? lines.slice(0, options.maxLines) : lines);
  }
  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const r = await this.readTextFile(path, context);
    if (!r.ok) return r;
    const text = r.value;
    let at = 0, closed = false;
    return ok({
      readLine: async () => {
        if (closed) return err(new FileError("invalid", "the reader is closed", path));
        if (at >= text.length) return ok(undefined);
        const nl = text.indexOf("\n", at);
        const line = nl < 0 ? { text: text.slice(at), terminated: false } : { text: text.slice(at, nl), terminated: true };
        at = nl < 0 ? text.length : nl + 1;
        return ok(line);
      },
      close: async () => { closed = true; },
    });
  }
  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const p = this.abs(path);
    // The file as it is now, whole: later calls read this copy, so a rename or a rewrite of the path does not change what the reader sees.
    const opened = await this.file(
      p,
      `check "$1"; if [ "$2" = 1 ] && [ -L "$1" ]; then exit 7; fi; [ -d "$1" ] && exit 4; [ -f "$1" ] || exit 7; [ -r "$1" ] || exit 6; find -L "$1" -maxdepth 0 -printf '%f\\0%y\\0%s\\0%T@\\0' >&2; cat -- "$1"`,
      [p, options?.noFollow ? "1" : "0"],
      context,
      (r) => ({ bytes: r.out, meta: r.err }),
    );
    if (!opened.ok) return opened;
    const { bytes } = opened.value;
    const m = opened.value.meta.split("\0");
    const info: FileInfo = { name: m[0] ?? posix.basename(p), path: p, kind: "file", size: bytes.length, mtimeMs: Math.round(Number(m[3]) * 1000) };
    let closed = false;
    const live = (ctx?: Context) => (closed ? err<never, FileError>(new FileError("invalid", "the reader is closed", p)) : ctx?.abortSignal?.aborted ? err<never, FileError>(new FileError("aborted", `aborted: ${p}`, p)) : null);
    const whole = (n: number) => Number.isInteger(n) && n >= 0;
    return ok({
      info: async (ctx: Context) => live(ctx) ?? ok(info),
      read: async (offset: number, length: number, ctx: Context) => live(ctx) ?? (!whole(offset) || !whole(length) ? err(new FileError("invalid", `offset ${offset} and length ${length} must be whole numbers, at least 0`, p)) : ok(bytes.slice(offset, offset + length))),
      scanLines: async ({ startLine, endLine }: { startLine: number; endLine?: number }, ctx: Context) => {
        const stop = live(ctx);
        if (stop) return stop;
        if (!whole(startLine) || (endLine !== undefined && (!whole(endLine) || endLine <= startLine))) return err(new FileError("invalid", `line range ${startLine}..${endLine} is not a range`, p));
        const s = new LineScanner(startLine, endLine);
        s.push(bytes);
        return ok(s.finish());
      },
      close: async () => { closed = true; },
    });
  }

  // ---- metadata and directories
  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const p = this.abs(path);
    const r = await this.file(p, `check "$1"; find "$1" -maxdepth 0 -printf '%f\\0%y\\0%s\\0%T@\\0'`, [p], context, (x) => parseFind(x.out)[0]);
    if (!r.ok) return r;
    const kind = kindOf(r.value!.y);
    if (!kind) return err(new FileError("invalid", `not a file, directory or symbolic link: ${p}`, p));
    return ok({ name: posix.basename(p) || "/", path: p, kind, size: r.value!.size, mtimeMs: r.value!.mtimeMs });
  }
  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const p = this.abs(path);
    return this.file(p, `if [ -e "$1" ] || [ -L "$1" ]; then printf 1; else printf 0; fi`, [p], context, (r) => decoder().decode(r.out) === "1");
  }
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const p = this.abs(path);
    const r = await this.file(p, `check "$1"; [ -d "$1" ] || exit 5; find -H "$1" -mindepth 1 -maxdepth 1 -printf '%f\\0%y\\0%s\\0%T@\\0'`, [p], context, (x) => parseFind(x.out));
    if (!r.ok) return r;
    return ok(r.value.flatMap((e) => { const kind = kindOf(e.y); return kind ? [{ name: e.p, path: posix.join(p, e.p), kind, size: e.size, mtimeMs: e.mtimeMs }] : []; }));
  }
  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const p = this.abs(path);
    // The names now; each page reads its entries' metadata when it is asked for, so an entry removed meanwhile is skipped.
    const names = await this.file(p, `check "$1"; [ -d "$1" ] || exit 5; find -H "$1" -mindepth 1 -maxdepth 1 -printf '%f\\0'`, [p], context, (x) => decoder().decode(x.out).split("\0").filter(Boolean));
    if (!names.ok) return names;
    const left = names.value;
    let closed = false;
    return ok({
      next: async (maxEntries: number, ctx: Context) => {
        if (closed) return err(new FileError("invalid", "the reader is closed", p));
        if (!Number.isInteger(maxEntries) || maxEntries < 1) return err(new FileError("invalid", `maxEntries ${maxEntries} must be a whole number, at least 1`, p));
        if (ctx?.abortSignal?.aborted) return err(new FileError("aborted", `aborted: ${p}`, p));
        const page = left.splice(0, maxEntries);
        if (page.length === 0) return ok({ entries: [], done: true });
        const r = await this.file(p, `cd -- "$1" || exit 3; shift; for n in "$@"; do [ -e "./$n" ] || [ -L "./$n" ] || continue; find "./$n" -maxdepth 0 -printf '%f\\0%y\\0%s\\0%T@\\0'; done`, [p, ...page], ctx, (x) => parseFind(x.out));
        if (!r.ok) return r;
        const entries = r.value.flatMap((e) => { const kind = kindOf(e.y); return kind ? [{ name: e.p, path: posix.join(p, e.p), kind, size: e.size, mtimeMs: e.mtimeMs }] : []; });
        return ok({ entries, done: left.length === 0 });
      },
      close: async () => { closed = true; },
    });
  }

  // ---- writes
  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const p = this.abs(path);
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    return this.file(p, `[ -d "$1" ] && exit 4; d=$(dirname -- "$1"); mkdir -p -- "$d" 2>/dev/null || { check "$d"; [ -d "$d" ] || exit 5; exit 6; }; cat > "$1" || exit 6`, [p], context, () => undefined, { stdin: bytes });
  }
  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const p = this.abs(path);
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    return this.file(p, `[ -d "$1" ] && exit 4; d=$(dirname -- "$1"); mkdir -p -- "$d" 2>/dev/null || { check "$d"; [ -d "$d" ] || exit 5; exit 6; }; cat >> "$1" || exit 6`, [p], context, () => undefined, { stdin: bytes });
  }
  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const p = this.abs(path);
    return this.file(p, `check "$1"; [ -d "$1" ] && exit 4; truncate -s "$2" -- "$1" || exit 6`, [p, String(size)], context, () => undefined);
  }
  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const p = this.abs(path);
    return this.file(p, `check "$1"; sync -- "$1" 2>/dev/null || sync`, [p], context, () => undefined);
  }
  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const s = this.abs(sourcePath), d = this.abs(destinationPath);
    return this.file(s, `check "$1"; if [ -d "$2" ] && [ ! -d "$1" ]; then exit 4; fi; if [ -d "$1" ] && [ -e "$2" ] && [ ! -d "$2" ]; then exit 5; fi; mv -fT -- "$1" "$2" || exit 6`, [s, d], context, () => undefined);
  }
  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const p = this.abs(path);
    if (options?.recursive) return this.file(p, `if [ -e "$1" ] && [ ! -d "$1" ]; then exit 5; fi; mkdir -p -- "$1" 2>/dev/null || { d=$(dirname -- "$1"); while [ ! -e "$d" ]; do d=$(dirname -- "$d"); done; [ -d "$d" ] || exit 5; exit 6; }`, [p], context, () => undefined);
    return this.file(p, `[ -e "$1" ] && exit 7; d=$(dirname -- "$1"); check "$d"; [ -d "$d" ] || exit 5; mkdir -- "$1" || exit 6`, [p], context, () => undefined);
  }
  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const p = this.abs(path);
    const script = options?.force
      ? `if [ -d "$1" ] && [ ! -L "$1" ] && [ "$2" != 1 ]; then exit 4; fi; rm -rf -- "$1" || exit 6`
      : `check "$1"; if [ -d "$1" ] && [ ! -L "$1" ] && [ "$2" != 1 ]; then exit 4; fi; rm -rf -- "$1" || exit 6`;
    return this.file(p, script, [p, options?.recursive ? "1" : "0"], context, () => undefined);
  }
  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.file("/tmp", `mktemp -d "\${TMPDIR:-/tmp}/$1XXXXXX"`, [prefix ?? "pi-"], context, (r) => decoder().decode(r.out).trim());
  }
  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.file("/tmp", `mktemp --suffix="$2" "\${TMPDIR:-/tmp}/$1XXXXXX"`, [options?.prefix ?? "pi-", options?.suffix ?? ""], context, (r) => decoder().decode(r.out).trim());
  }

  // ---- watch: polling snapshots of the targets (a remote box reports no events)
  async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    const snap = async (ctx?: Context): Promise<Map<string, string>> => {
      const args: string[] = [];
      for (const t of targets) args.push(this.abs(t.path), t.recursive ? "1" : "0", (t.exclude?.hidden ? "1" : "0"), (t.exclude?.names ?? []).join("/"));
      const r = await this.call(["sh", "-c", `while [ $# -gt 0 ]; do p=$1; r=$2; h=$3; x=$4; shift 4; [ -e "$p" ] || [ -L "$p" ] || continue; if [ "$r" = 1 ]; then find -H "$p" -printf '%p\\0%y\\0%s\\0%T@\\0'; else find -H "$p" -maxdepth 1 -printf '%p\\0%y\\0%s\\0%T@\\0'; fi; done`, "sh", ...args], { context: ctx });
      if (r.code !== 0) throw new FileError("unknown", r.err.trim().slice(-200));
      const m = new Map<string, string>();
      for (const e of parseFind(r.out)) {
        const t = targets.find((t) => e.p === this.abs(t.path) || e.p.startsWith(this.abs(t.path) + "/"));
        if (t && e.p !== this.abs(t.path)) {
          const rel = e.p.slice(this.abs(t.path).length + 1).split("/");
          if (t.exclude?.hidden && rel.some((s) => s.startsWith("."))) continue;
          if (t.exclude?.names?.length && rel.some((s) => t.exclude!.names!.includes(s))) continue;
        }
        m.set(e.p, `${e.y}:${e.size}:${e.mtimeMs}`);
      }
      return m;
    };
    let last: Map<string, string>;
    try { last = await snap(context); } catch (e) { return err(this.fileError(e, targets[0]?.path ?? "")); }
    let stopped = false, busy: Promise<void> = Promise.resolve();
    const tick = async () => {
      if (stopped) return;
      let now: Map<string, string>;
      try { now = await snap(); } catch (e) { if (!stopped) { stopped = true; clearInterval(timer); onChange({ error: this.fileError(e, targets[0]?.path ?? "") }); } return; }
      if (stopped) return;
      const changed: string[] = [];
      for (const [p, v] of now) if (last.get(p) !== v) changed.push(p);
      for (const p of last.keys()) if (!now.has(p)) changed.push(p);
      last = now;
      if (changed.length) onChange({ paths: changed });
    };
    const timer = setInterval(() => { busy = busy.then(tick); }, this.watchIntervalMs);
    const w = { mode: "polling" as const, close: async () => { stopped = true; clearInterval(timer); await busy.catch(() => {}); this.watchers.delete(w); } };
    this.watchers.add(w);
    return ok(w);
  }

  // ---- commands
  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (this.lost !== null) return err(new ExecutionError("unknown", this.goneMessage()));
    if (Array.isArray(command) && command.length === 0) return err(new ExecutionError("spawn_error", "no program to run"));
    const id = `${process.pid}-${Date.now()}-${++this.seq}`;
    const cwd = options?.cwd ? this.abs(options.cwd) : this.cwd;
    const argv = typeof command === "string" ? ["bash", "-c", command] : [...command];
    const envArgs = Object.entries(options?.env ?? {}).map(([k, v]) => `${k}=${v}`);
    // The command runs as its own process group (setsid), whose id is written down, so an abort or a timeout kills all of it.
    // `-w`: where the exec's process already leads a group (Modal's does), setsid forks, and without -w it would return at once.
    // A cancel that comes before the group is written down leaves a tombstone (`.cancel`); the wrapper writes its group first and
    // then looks for one, and `kill` looks for the group, leaves the tombstone, and looks again: a late start never runs on.
    // (dash, the usual /bin/sh, takes `kill -TERM -<group>` but not `kill -TERM -- -<group>`)
    const wrap = `mkdir -p /tmp/.pi-remote; f=/tmp/.pi-remote/$1.pid; x=/tmp/.pi-remote/$1.cancel; echo $$ > "$f"; if [ -e "$x" ]; then rm -f "$f" "$x"; exit 130; fi; cd -- "$2" 2>/dev/null || { rm -f "$f"; echo "pi-remote: cwd: $2: not found" >&2; exit 200; }; shift 2; if [ "$PI_ARGV" = 1 ] && ! command -v -- "$1" >/dev/null 2>&1; then rm -f "$f"; echo "pi-remote: spawn: $1: not found" >&2; exit 201; fi; unset PI_ARGV; "$@"; c=$?; rm -f "$f"; exit $c`;
    const full = ["env", ...(options?.inheritEnv === false ? ["-i", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"] : []), ...envArgs, `PI_ARGV=${typeof command === "string" ? 0 : 1}`, "setsid", "-w", "sh", "-c", wrap, "pi-exec", id, cwd, ...argv];
    const timeoutMs = options?.timeout !== undefined ? options.timeout * 1000 : this.maxExecMs;
    const kill = () => this.call(["sh", "-c", `mkdir -p /tmp/.pi-remote; f=/tmp/.pi-remote/$1.pid; stop() { g=$(cat "$f"); kill -TERM "-$g" 2>/dev/null; sleep 1; kill -KILL "-$g" 2>/dev/null; rm -f "$f"; }; if [ -f "$f" ]; then stop; exit 0; fi; touch /tmp/.pi-remote/$1.cancel; [ -f "$f" ] && stop; true`, "sh", id], { ms: 5_000 }).catch(() => undefined); // best effort, and short: it is on the way out of a call
    this.running.add(id);
    // The output, for the spill file a long output gets: in memory up to the thresholds, then in a file on this host, so a
    // long and noisy command never holds its whole output in memory; the file goes to the box in pieces at the end.
    const spill = options?.spill;
    let total = 0, lines = 0, spilling = false;
    let early: Uint8Array[] = [];
    let local: { path: string; fh: FileHandle } | null = null;
    let spillChain: Promise<void> = Promise.resolve();
    let spillError: unknown = null;
    // every write is queued on one chain whose failure is caught right there (kept in spillError, never an unhandled rejection)
    const queue = (write: () => Promise<void>) => { spillChain = spillChain.then(() => (spillError === null ? write() : undefined)).catch((e) => { spillError ??= e; }); return spillChain; };
    const keep = (c: Uint8Array): Promise<void> => {
      total += c.length;
      for (const b of c) if (b === 10) lines++;
      if (spilling) return queue(async () => { await local!.fh.write(c); });
      early.push(c);
      if (total > spill!.afterBytes || lines > spill!.afterLines) {
        spilling = true;
        const parts = early;
        early = [];
        return queue(async () => {
          const path = joinLocal(tmpdir(), `pi-remote-spill-${id}.txt`);
          local = { path, fh: await open(path, "w") };
          for (const x of parts) await local.fh.write(x);
        });
      }
      return spillChain;
    };
    const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
    let stderrTail = "";
    const pump = async (s: RemoteStream, stream: "stdout" | "stderr") => {
      for await (const c of chunks(s)) {
        if (spill) {
          await keep(c); // the output waits for the disk, so a slow or full disk is felt here, not later
          if (spillError !== null) throw new SpillFailed(`this host could not keep the command's output for its spill file: ${(spillError as Error)?.message ?? spillError}`);
        }
        let text = decoders[stream].decode(c);
        if (stream === "stderr") {
          stderrTail = (stderrTail + text).slice(-400);
          text = text.replace(/^pi-remote: (spawn|cwd): [^\n]*\n?/m, "");
        }
        if (text) options?.onOutput?.(text, context, { stream });
      }
      const rest = decoders[stream].decode();
      if (rest) options?.onOutput?.(rest, context, { stream });
    };
    const writeSpill = async (): Promise<string | undefined> => {
      await spillChain;
      const mine = local as { path: string; fh: FileHandle } | null;
      if (!spilling || !mine || spillError !== null) return undefined;
      try {
        await mine.fh.close();
        const f = await this.createTempFile({ prefix: "pi-out-", suffix: ".txt" }, context);
        if (!f.ok) return undefined;
        const piece = Buffer.alloc(4 * 1024 * 1024);
        const fh = await open(mine.path, "r");
        try {
          for (let at = 0; ; ) {
            const { bytesRead } = await fh.read(piece, 0, piece.length, at);
            if (bytesRead === 0) break;
            const w = await this.appendFile(f.value, piece.subarray(0, bytesRead), context);
            if (!w.ok) return undefined;
            at += bytesRead;
          }
        } finally {
          await fh.close();
        }
        return f.value;
      } finally {
        await rm(mine.path, { force: true });
      }
    };
    const launch = this.box.exec(full, { mode: "binary", timeoutMs: seconds(timeoutMs + 30_000) });
    let started = false;
    try {
      const p = await bounded(launch, Math.max(timeoutMs, Math.min(this.opTimeoutMs, 30_000)), context);
      started = true;
      // closing stdin is part of the bounded run: a stalled connection there is a timeout or an abort like any other
      const run = (async () => {
        await p.stdin.close().catch(() => {});
        const [, , code] = await Promise.all([pump(p.stdout, "stdout"), pump(p.stderr, "stderr"), p.wait()]);
        return code;
      })();
      let code: number;
      try {
        code = await bounded(run, timeoutMs, context);
      } catch (e) {
        if (e instanceof SpillFailed) { await kill(); return err(new ExecutionError("unknown", e.message)); }
        const aborted = isAbort(e);
        if (!aborted && !(e instanceof Timeout)) throw e;
        await kill();
        const path = await writeSpill().catch(() => undefined);
        const xe = new ExecutionError(aborted ? "aborted" : "timeout", aborted ? "the command was aborted" : `the command timed out after ${timeoutMs / 1000} s`);
        if (path) xe.spillPath = path;
        return err(xe);
      }
      if (code === 201 && /pi-remote: spawn: /.test(stderrTail)) return err(new ExecutionError("spawn_error", stderrTail.match(/pi-remote: spawn: ([^\n]*)/)![1]!));
      if (code === 200 && /pi-remote: cwd: /.test(stderrTail)) return err(new ExecutionError("spawn_error", stderrTail.match(/pi-remote: cwd: ([^\n]*)/)![1]!));
      const spillPath = await writeSpill();
      return ok({ exitCode: code, ...(spillPath ? { spillPath } : {}) });
    } catch (e) {
      if (!started) {
        // given up before the box answered: if the launch lands later, its command is stopped (and the tombstone stops it if it starts)
        launch.then(async (late) => { await late.stdin.close().catch(() => {}); await kill(); }, () => undefined);
      }
      if (isAbort(e)) { await kill(); return err(new ExecutionError("aborted", "the command was aborted")); }
      await this.diagnose(e);
      if (this.lost !== null) return err(new ExecutionError("unknown", this.goneMessage()));
      if (e instanceof Timeout) { await kill(); return err(new ExecutionError("timeout", `the box ${this.box.sandboxId} did not start the command in time`)); }
      return err(new ExecutionError("spawn_error", `the box ${this.box.sandboxId} did not run the command: ${(e as Error)?.message ?? e}`));
    } finally {
      this.running.delete(id);
      const leftover = local as { path: string; fh: FileHandle } | null; // a spill file that was not sent (a failure on the way)
      if (leftover) { await leftover.fh.close().catch(() => undefined); await rm(leftover.path, { force: true }).catch(() => undefined); }
    }
  }

  async cleanup(context: Context): Promise<void> {
    for (const w of [...this.watchers]) await w.close(context).catch(() => {});
    if (this.lost !== null || this.running.size === 0) return;
    const ids = [...this.running];
    await this.call(["sh", "-c", `for id in "$@"; do f=/tmp/.pi-remote/$id.pid; [ -f "$f" ] && kill -KILL "-$(cat "$f")" 2>/dev/null; rm -f "$f"; done; true`, "sh", ...ids], { ms: 15_000 }).catch(() => undefined);
  }
}

// ---- artifact sync ------------------------------------------------------------------------------------------------------------

export interface ArtifactSyncOptions {
  box: RemoteBox;
  /** A directory on the box (a thread's `skills/<skill>/`). */
  remote: string;
  /** Where its files land on the session's disk (`<work>/skills/<skill>/`). */
  local: string;
  /** How often the box is listed. Default 2 s. */
  intervalMs?: number;
  /** A file that just landed, whole, under `local`. */
  onFile?(rel: string, size: number): void;
  /** The box went away or a copy failed for good; the sync has stopped. */
  onError?(error: Error): void;
  /** Deadline of one listing or one file's copy. Default 120 s. */
  opTimeoutMs?: number;
  /** Paths under `remote` that stay on the box (a trainer's own state): each is skipped with everything below it. */
  exclude?: readonly string[];
}

/**
 * Copies new and changed files under `remote` on the box to `local`, while the box lives. A file is copied once it has looked
 * the same (size and mtime) in two listings in a row, so one still being written is not taken; `flush` copies everything
 * that differs at once (for when the thread's programs have finished). Each copy is written to a temporary file next to its
 * target and renamed into place.
 */
export class ArtifactSync {
  private readonly o: Required<Omit<ArtifactSyncOptions, "onFile" | "onError" | "exclude">> & Pick<ArtifactSyncOptions, "onFile" | "onError" | "exclude">;
  private copied = new Map<string, string>();
  private seen = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private stopped = false;
  files = 0;
  bytes = 0;

  constructor(o: ArtifactSyncOptions) {
    this.o = { intervalMs: 2_000, opTimeoutMs: 120_000, ...o };
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { this.busy = this.busy.then(() => this.pass(false)).catch((e) => this.fail(e)); }, this.o.intervalMs);
  }

  /** Copy everything that differs now, then return the totals copied so far. */
  async flush(context?: Context): Promise<{ files: number; bytes: number }> {
    // on the same chain as the timer's passes, so a pass never runs beside another and nothing is copied twice
    const mine = this.busy.catch(() => {}).then(() => this.pass(true, context));
    this.busy = mine.catch(() => {});
    await mine;
    return { files: this.files, bytes: this.bytes };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy.catch(() => {});
  }

  private fail(e: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.o.onError?.(e instanceof Error ? e : new Error(String(e)));
  }

  private async exec(argv: string[], context?: Context) {
    const p = await bounded(this.o.box.exec(argv, { mode: "binary", timeoutMs: seconds(this.o.opTimeoutMs + 5_000) }), this.o.opTimeoutMs, context);
    await bounded(p.stdin.close().catch(() => {}), this.o.opTimeoutMs, context); // a stalled close must not hold a flush or a stop
    return p;
  }

  private async pass(all: boolean, context?: Context): Promise<void> {
    // the find expression as arguments (never spliced into the script): pruned paths first, then the files
    // a path, not a pattern: find's -path treats * ? [ ] and \\ as pattern characters, so they are escaped
    const literal = (x: string) => x.replace(/[*?[\]\\]/g, (c) => `\\${c}`);
    const prune = (this.o.exclude ?? []).map((x) => x.replace(/^\.?\/+|\/+$/g, "")).filter(Boolean).flatMap((x, i) => [...(i ? ["-o"] : []), "-path", `./${literal(x)}`]);
    const expr = [...(prune.length ? ["(", ...prune, ")", "-prune", "-o"] : []), "-type", "f", "!", "-name", "*.tmp", "!", "-name", ".*", "-printf", "%P\\0%y\\0%s\\0%T@\\0"];
    const p = await this.exec(["sh", "-c", `[ -d "$1" ] || exit 0; cd -- "$1" && shift && find . "$@"`, "sh", this.o.remote, ...expr], context);
    const [out, errBytes, code] = await bounded(Promise.all([readAll(p.stdout), readAll(p.stderr), p.wait()]), this.o.opTimeoutMs, context);
    if (code !== 0) throw new Error(`listing ${this.o.remote} on ${this.o.box.sandboxId} failed (${code}): ${decoder().decode(errBytes).trim().slice(-200)}`);
    const now = parseFind(out);
    now.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const due: typeof now = [];
    for (const f of now) {
      const v = `${f.size}:${f.mtimeMs}`;
      if (this.copied.get(f.p) === v) continue;
      if (!this.copied.has(f.p) && (await this.present(f.p, f.size, f.mtimeMs))) { this.copied.set(f.p, v); continue; } // copied before a restart
      if (all || this.seen.get(f.p) === v) due.push(f);
      this.seen.set(f.p, v);
    }
    for (const f of due) {
      if (this.stopped && !all) return;
      const v = `${f.size}:${f.mtimeMs}`;
      if (this.copied.get(f.p) === v) continue;
      await this.copy(f.p, v, context);
    }
  }

  /** A file already on the session's disk with the box's size and modification time (a copy keeps the box's mtime). */
  private async present(rel: string, size: number, mtimeMs: number): Promise<boolean> {
    try {
      const s = await stat(joinLocal(this.o.local, rel));
      return s.isFile() && s.size === size && Math.abs(s.mtimeMs - mtimeMs) < 2;
    } catch {
      return false;
    }
  }

  /**
   * Copy one file into place. Its size and mtime are read on the box before and after the bytes; a file that changed (or is not
   * the version listed) is not published: its copy is dropped and a later pass takes it once it is stable again.
   */
  private async copy(rel: string, version: string, context?: Context): Promise<void> {
    const target = joinLocal(this.o.local, rel);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    const p = await this.exec(["sh", "-c", `s1=$(find "$1" -maxdepth 0 -printf '%s:%T@') || exit 3; cat -- "$1" || exit 4; s2=$(find "$1" -maxdepth 0 -printf '%s:%T@') || exit 3; printf '%s\\n%s\\n' "$s1" "$s2" >&2`, "sh", posix.join(this.o.remote, rel)], context);
    // a file handle, not a stream: a full or unwritable disk is a rejection here, never an unhandled 'error' event
    let fh: FileHandle | null = null;
    let n = 0, stamps = "";
    try {
      fh = await open(tmp, "w");
      const out = fh;
      await bounded((async () => {
        const errText = readAll(p.stderr);
        for await (const c of chunks(p.stdout)) {
          n += c.length;
          await out.write(c);
        }
        const [errBytes, code] = await Promise.all([errText, p.wait()]);
        stamps = decoder().decode(errBytes);
        if (code !== 0) throw new Error(`copying ${rel} failed (${code}): ${stamps.trim().slice(-200)}`);
      })(), this.o.opTimeoutMs, context);
      await fh.close();
      fh = null;
      const [before, after] = stamps.trim().split("\n").slice(-2).map((x) => { const [size, t] = x.split(":"); return `${Number(size)}:${Math.round(Number(t) * 1000)}`; });
      if (before !== version || after !== version || n !== Number(version.split(":")[0])) {
        // changed under the copy: not published; the listing that sees it settle copies it
        this.seen.set(rel, after ?? "");
        await rm(tmp, { force: true });
        return;
      }
      const mtime = Number(version.split(":")[1]) / 1000;
      await utimes(tmp, mtime, mtime); // the box's time, so a sync started after a restart knows this copy
      await rename(tmp, target);
    } catch (e) {
      await fh?.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw e;
    }
    this.copied.set(rel, version);
    this.files++;
    this.bytes += n;
    this.o.onFile?.(rel, n);
  }
}

// ---- the Harness's env ----------------------------------------------------------------------------------------------------------

/**
 * HarnessOptions.env for a session whose threads have boxes: `boxFor` names a conversation's box (or none: the default env).
 * One RemoteEnv per box, kept, so its lost state is the same for every tool call of the thread. Its cwd is the box's
 * workspace, whatever the conversation's cwd on the host is.
 */
export function remoteEnvs(
  boxFor: (target: EnvTarget, context: Context) => RemoteBox | undefined | Promise<RemoteBox | undefined>,
  options: Omit<RemoteEnvOptions, "box"> & {
    /** The env of a conversation without a box (the root, on the session's host); absent: pi's default. */
    fallback?: (target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
  } = {},
): (target: EnvTarget, context: Context) => Promise<ExecutionEnv | undefined> {
  const { fallback, ...envOptions } = options;
  const envs = new Map<string, RemoteEnv>();
  return async (target, context) => {
    const box = await boxFor(target, context);
    if (!box) return fallback?.(target, context);
    let env = envs.get(box.sandboxId);
    if (!env) {
      env = new RemoteEnv({ ...envOptions, box });
      envs.set(box.sandboxId, env);
    }
    return env;
  };
}

// ---- pi-run: one run per key on a box ---------------------------------------------------------------------------------------------

/**
 * `pi-run <key> -- <command...>`, installed on a box: at most one run per key there. The box outlives the session's host, so
 * after a host restart a tool that reruns its command would start a second trainer beside the first; pi-run stops the process
 * group of the previous run of the same key first. It records the group of the tool call it runs in, so an abort of that call
 * still ends the command (RemoteEnv kills the call's group).
 */
export const PI_RUN = `#!/bin/sh
# pi-run <key> -- <command...>: stop the previous run of <key> on this box (its process group), then run the command.
# The key is hashed whole (two keys never share a record), and the check, the stop and the record are done under one lock.
[ $# -ge 1 ] || { echo "usage: pi-run <key> -- <command...>" >&2; exit 2; }
key=$1; shift; [ "$1" = "--" ] && shift
d=/tmp/.pi-run; mkdir -p "$d"
k=$(printf %s "$key" | sha256sum | cut -c1-32)
f="$d/$k.pgid"; l="$d/$k.lock"
g=$(cut -d' ' -f5 /proc/$$/stat)
exec 9>"$l"; flock 9
if [ -f "$f" ]; then
  old=$(cat "$f")
  if [ -n "$old" ] && [ "$old" != "$g" ]; then
    kill -TERM "-$old" 2>/dev/null; i=0
    while kill -0 "-$old" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.5; i=$((i+1)); done
    kill -KILL "-$old" 2>/dev/null
  fi
fi
echo "$g" > "$f"
exec 9>&-
"$@"; c=$?
exec 9>"$l"; flock 9
[ "$(cat "$f" 2>/dev/null)" = "$g" ] && rm -f "$f"
exec 9>&-
exit $c
`;

/** Install pi-run on a box (at `path`, default /usr/local/bin/pi-run). For a pool that creates boxes itself. */
export async function installPiRun(box: RemoteBox, path = "/usr/local/bin/pi-run"): Promise<void> {
  // a temporary file renamed into place: a pi-run started meanwhile reads the old script or the new one, never a partial one
  const p = await box.exec(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && t="$1.tmp.$$" && cat > "$t" && chmod 755 "$t" && mv -f -- "$t" "$1"', "sh", path], { mode: "binary", timeoutMs: 60_000 });
  const [, e, code] = await bounded((async () => {
    await p.stdin.writeBytes(enc.encode(PI_RUN));
    await p.stdin.close();
    return Promise.all([readAll(p.stdout), readAll(p.stderr), p.wait()]);
  })(), 60_000);
  if (code !== 0) throw new Error(`could not install pi-run at ${path}: ${decoder().decode(e).trim().slice(-200)}`);
}

// ---- GPU boxes on Modal ------------------------------------------------------------------------------------------------------------

/** The part of the Modal SDK `modalGpuBoxes` uses (the `ModalClient`'s apps, images and sandboxes). Its sandboxes are RemoteBoxes. */
export interface ModalGpuSdk {
  apps: { fromName(name: string, params: { createIfMissing: boolean }): Promise<{ appId: string }> };
  images: { fromRegistry(tag: string): unknown; fromId(id: string): Promise<unknown> };
  sandboxes: {
    create(app: { appId: string }, image: unknown, params: Record<string, unknown>): Promise<RemoteBox & { setTags(t: Record<string, string>): Promise<void>; terminate(): Promise<void> }>;
    fromId(id: string): Promise<RemoteBox & { terminate(): Promise<void> }>;
    list(params: { appId: string; tags: Record<string, string> }): AsyncIterable<RemoteBox & { terminate(): Promise<void> }>;
  };
}

export interface ModalGpuBoxesOptions {
  appName: string;
  /** A registry tag, a Modal image id (`im-...`), or a function returning an SDK Image. */
  image: string | (() => unknown | Promise<unknown>);
  /** Modal's GPU spec. Default "H100". */
  gpu?: string;
  /** Modal ends a box this long after it was created, whatever happens to its owner (the backstop for a leak). Default 2 h. */
  timeoutMs?: number;
  /** The workspace made on each box. Default /workspace. */
  root?: string;
  /** Anything else sandboxes.create accepts (cpu, memoryMiB, regions, volumes, secrets...). */
  create?: Record<string, unknown>;
  /** Where pi-run is installed on each box. Default /usr/local/bin/pi-run. */
  piRunPath?: string;
}

/**
 * GPU boxes for threads, found again by key: `ensure(key)` adopts the live box tagged with `key` or creates one, so a step that
 * creates boxes can run again after a crash without starting a second box for the same thread. The caller keeps the
 * sandboxId durably; `get` finds a box again after a restart and `terminate` ends it.
 */
export function modalGpuBoxes(sdk: ModalGpuSdk, o: ModalGpuBoxesOptions) {
  const root = o.root ?? "/workspace";
  let app: Promise<{ appId: string }> | undefined;
  let image: Promise<unknown> | undefined;
  const theApp = () => (app ??= sdk.apps.fromName(o.appName, { createIfMissing: true }).catch((e) => { app = undefined; throw e; }));
  const theImage = () => (image ??= Promise.resolve(typeof o.image === "function" ? o.image() : o.image.startsWith("im-") ? sdk.images.fromId(o.image) : sdk.images.fromRegistry(o.image)).catch((e) => { image = undefined; throw e; }));
  // The key, whole, as a tag value: its sha256 (a tag cannot hold any key, and a prefix would let two threads share a box).
  const tagOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 40);
  type Box = RemoteBox & { terminate(): Promise<void> };
  const live = async (appId: string, key: string): Promise<Box[]> => {
    const out: Box[] = [];
    for await (const box of sdk.sandboxes.list({ appId, tags: { "pi-box": tagOf(key) } })) if ((await box.poll()) === null) out.push(box);
    return out;
  };
  // One winner for every creator of a key: the box with the smallest id. The others are duplicates and are ended.
  const settle = async (boxes: Box[]): Promise<Box> => {
    const sorted = [...new Map(boxes.map((b) => [b.sandboxId, b])).values()].sort((a, b) => (a.sandboxId < b.sandboxId ? -1 : 1));
    for (const extra of sorted.slice(1)) await extra.terminate().catch(() => {});
    return sorted[0]!;
  };
  /** The workspace and pi-run, on a new box or on one adopted after a crash between its creation and its setup. Idempotent. */
  const setup = async (box: RemoteBox) => {
    const p = await bounded(box.exec(["mkdir", "-p", root], { mode: "binary", timeoutMs: 60_000 }), 60_000);
    const code = await bounded((async () => { await p.stdin.close(); await Promise.all([readAll(p.stdout), readAll(p.stderr)]); return p.wait(); })(), 60_000);
    if (code !== 0) throw new Error(`could not make ${root} on ${box.sandboxId}`);
    await installPiRun(box, o.piRunPath);
  };
  const inflight = new Map<string, Promise<RemoteBox>>();
  return {
    /** The live box for `key` (set up), adopting one a previous run created, or a new one; concurrent calls share the work. */
    ensure(key: string, tags: Record<string, string> = {}): Promise<RemoteBox> {
      const pending = inflight.get(key);
      if (pending) return pending;
      const work = (async () => {
        const a = await theApp();
        const found = await live(a.appId, key);
        if (found.length) {
          const box = await settle(found);
          await setup(box);
          return box;
        }
        const name = `pi-box-${tagOf(key).slice(0, 12)}-${Date.now().toString(36)}`;
        const mine = await sdk.sandboxes.create(a, await theImage(), { ...o.create, name, gpu: o.gpu ?? "H100", timeoutMs: o.timeoutMs ?? 2 * 3_600_000 });
        try {
          await mine.setTags({ ...tags, "pi-box": tagOf(key), "pi-box-key": key.slice(0, 63) });
          // another creator (another process) may have raced this one: every creator settles on the same box
          const box = await settle([mine, ...(await live(a.appId, key))]);
          await setup(box);
          return box;
        } catch (e) {
          await mine.terminate().catch(() => {});
          throw e;
        }
      })().finally(() => inflight.delete(key));
      inflight.set(key, work);
      return work;
    },
    async get(sandboxId: string): Promise<RemoteBox | undefined> {
      try {
        const box = await sdk.sandboxes.fromId(sandboxId);
        return (await box.poll()) === null ? box : undefined;
      } catch {
        return undefined;
      }
    },
    async terminate(sandboxId: string): Promise<void> {
      const box = await sdk.sandboxes.fromId(sandboxId).catch(() => undefined);
      await box?.terminate().catch(() => {});
    },
  };
}
