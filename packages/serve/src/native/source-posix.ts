/** macOS lacks procfs. A private Python 3 process supplies openat/fstat/pread/fdopendir and fchdir without
 * resolving an already approved parent again. It receives no provider credentials or Python startup settings. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { Stats, BigIntStats } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SourceSnapshotOptions } from "./source-snapshot-types.js";
import { SourceSnapshotError } from "./source-snapshot-error.js";

function python(): string {
  // Resolve only installation locations, never a project-controlled PATH or Python startup file.
  for (const path of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
    try { accessSync(path, constants.X_OK); return path; } catch { /* next installation */ }
  }
  throw new SourceSnapshotError("unsupported_platform", "Install Python 3 to capture a local setup safely on macOS, then retry.");
}

export class PosixSourceReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private next = 0;
  private buffer = "";
  private failure?: Error;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort = () => this.fail(new SourceSnapshotError("source_unavailable", "Source snapshot was cancelled."));
  constructor(readonly deadline: number, readonly signal?: AbortSignal) {
    this.child = spawn(python(), ["-I", "-S", "-u", fileURLToPath(new URL("source-posix.py", import.meta.url))], {
      detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" },
    });
    this.timer = setTimeout(() => this.fail(new SourceSnapshotError("limit", "Source snapshot exceeded its time limit.")), Math.max(1, deadline - Date.now()));
    this.child.once("error", () => this.fail(new SourceSnapshotError("unsupported_platform", "Install Python 3 to capture a local setup safely on macOS, then retry.")));
    this.child.once("close", () => this.fail(new SourceSnapshotError("source_unavailable", "The private source reader stopped before completing capture.")));
    this.child.stdin.on("error", () => this.fail(new SourceSnapshotError("source_unavailable", "The private source reader could not accept a request.")));
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 128 * 1024 * 1024) { this.fail(new SourceSnapshotError("limit", "Source reader exceeded its response bound.")); return; }
      for (;;) {
        const end = this.buffer.indexOf("\n"); if (end < 0) break;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const response = JSON.parse(line), held = this.pending.get(response.id);
          if (!held) throw new Error(); this.pending.delete(response.id);
          if (response.error) {
            const code = response.error;
            held.reject(["source_changed", "source_unavailable", "limit"].includes(code)
              ? new SourceSnapshotError(code, code === "source_changed" ? "An approved source folder changed during capture." : code === "limit" ? "Source capture exceeded its bound." : "A source path could not be read safely.")
              : Object.assign(new Error("A source path could not be opened safely."), { code }));
          } else held.resolve(response.value);
        } catch { this.fail(new SourceSnapshotError("source_unavailable", "The private source reader returned an invalid response.")); }
      }
    });
    signal?.addEventListener("abort", this.abort, { once: true }); if (signal?.aborted) this.abort();
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error; clearTimeout(this.timer); this.signal?.removeEventListener("abort", this.abort);
    for (const held of this.pending.values()) held.reject(error);
    this.pending.clear(); this.buffer = "";
    try { if (this.child.pid) process.kill(-this.child.pid, "SIGKILL"); } catch { /* already stopped */ }
  }
  call<T>(op: string, args: Record<string, unknown>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.next; this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ ...args, id, op }) + "\n");
    });
  }
  async open(path: string, roots: SourceSnapshotOptions["expectedRoots"] = []) {
    return new PosixSourceHandle(this, await this.call<number>("open", { path, roots }));
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = new Promise<void>(resolve => this.child.once("close", () => resolve()));
    this.fail(new SourceSnapshotError("source_unavailable", "Source reader closed."));
    await closed;
  }
}

export class PosixSourceHandle {
  constructor(private readonly reader: PosixSourceReader, readonly fd: number) {}
  async stat(options: { bigint: true }): Promise<BigIntStats>;
  async stat(options?: { bigint?: false }): Promise<Stats>;
  async stat(options?: { bigint?: boolean }): Promise<Stats | BigIntStats> {
    const info = await this.reader.call<Record<string, any>>("stat", { fd: this.fd });
    const number = (value: string | number) => options?.bigint ? BigInt(Math.trunc(Number(value))) : Number(value);
    return { ...Object.fromEntries(["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].map(key => [key,
      options?.bigint && ["dev", "ino"].includes(key) ? BigInt(info[key]) : number(info[key])])),
      isDirectory: () => info.directory, isFile: () => info.file } as Stats | BigIntStats;
  }
  async read(buffer: Buffer, offset: number, length: number, position: number) {
    const bytes = Buffer.from(await this.reader.call<string>("read", { fd: this.fd, length, position }), "base64");
    bytes.copy(buffer, offset); return { bytesRead: bytes.length };
  }
  names(max: number): Promise<string[]> { return this.reader.call("names", { fd: this.fd, max }); }
  async git(args: string[], env: Record<string, string>, max: number) {
    return Buffer.from(await this.reader.call<string>("git", { fd: this.fd, args, env, max, timeout: Math.max(1, this.reader.deadline - Date.now()) }), "base64");
  }
  async close(): Promise<void> { await this.reader.call("close", { fd: this.fd }); }
}
