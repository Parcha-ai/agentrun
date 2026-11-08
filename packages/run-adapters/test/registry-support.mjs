// A run's hands on a local folder, for the kernel registry's tests: files under `root`, commands run by `bash -c` in
// `root` with a fixed minimal env, and (with `processes: true`) a computer's process port played by local processes,
// each in a group of its own, its stdout and stderr kept as its log the way a computer keeps it.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, lstatSync } from "node:fs";
import { appendFile, lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const LOG_BYTES = 16 * 1024 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });

/** A computer's processes, played locally: what the kernel's port asks of one. */
export function localProcesses(root) {
  const procs = new Map();
  let next = 1;
  /** A pty's line discipline, as far as the tests need it: input is held until a newline; Ctrl-D sends a held partial
   *  line on, or, at a line's start, ends the input. */
  const typed = (p, data) => {
    for (const byte of data) {
      if (byte === 0x04) {
        if (p.line.length === 0) {
          p.child.stdin.end();
          p.closed = true;
          return;
        }
        p.child.stdin.write(Buffer.from(p.line));
        p.line = [];
      } else {
        p.line.push(byte);
        if (byte === 0x0a) {
          p.child.stdin.write(Buffer.from(p.line));
          p.line = [];
        }
      }
    }
  };
  const get = (handle) => {
    const p = procs.get(handle);
    if (!p) throw failure("not_found", `no process ${handle}`);
    return p;
  };
  const port = {
    starts: 0,
    /** Awaited before each start: a test holds a start here. */
    beforeStart: async () => {},
    async start({ argv, cwd, log, pty }) {
      await port.beforeStart();
      port.starts++;
      const logPath = resolve(root, log);
      const dir = dirname(dirname(logPath));
      try {
        if (lstatSync(dir).isSymbolicLink()) throw failure("denied", `${dir} is a link`);
      } catch (error) {
        if (error.code === "denied") throw error;
      }
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, "");
      const child = spawn(argv[0], argv.slice(1), { cwd: resolve(root, cwd), detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: root } });
      const p = { handle: String(next++), argv: [...argv], running: true, exitCode: null, signal: null, startedAt: Date.now(), pty: Boolean(pty), bytes: Buffer.alloc(0), capped: false, child, closed: false, line: [] };
      const keep = (data) => {
        const room = LOG_BYTES - p.bytes.length;
        if (room <= 0) return void (p.capped = true);
        const part = data.subarray(0, room);
        if (part.length < data.length) p.capped = true;
        p.bytes = Buffer.concat([p.bytes, part]);
        appendFileSync(logPath, part);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.stdin.on("error", () => {});
      child.on("exit", (code, signal) => {
        p.running = false;
        p.exitCode = code;
        p.signal = signal ? signal.replace(/^SIG/, "") : null;
      });
      procs.set(p.handle, p);
      await new Promise((ready) => child.once("spawn", ready));
      return { handle: p.handle, pid: child.pid };
    },
    async read(handle, { offset, maxBytes }) {
      const p = get(handle);
      if (offset > p.bytes.length) throw failure("invalid", `offset ${offset} is past the log's end`);
      return { data: new Uint8Array(p.bytes.subarray(offset, offset + maxBytes)), size: p.bytes.length, capped: p.capped };
    },
    async write(handle, { data, close }) {
      const p = get(handle);
      if (p.closed) throw failure("invalid", "stdin is closed");
      if (p.pty) {
        if (close) throw failure("invalid", "a terminal has no stdin to close");
        if (data && data.length > 0) typed(p, data);
        return;
      }
      if (data && data.length > 0) p.child.stdin.write(Buffer.from(data));
      if (close) {
        p.child.stdin.end();
        p.closed = true;
      }
    },
    async signal(handle, name) {
      const p = get(handle);
      try {
        process.kill(-p.child.pid, `SIG${name}`);
      } catch {}
      return {};
    },
    async list() {
      return [...procs.values()].map((p) => ({ handle: p.handle, argv: [...p.argv], running: p.running, exitCode: p.exitCode, signal: p.signal, startedAt: p.startedAt, pty: p.pty }));
    },
    /** Every process still running, killed: a test's cleanup. */
    reap() {
      for (const p of procs.values()) if (p.running) try { process.kill(-p.child.pid, "SIGKILL"); } catch {}
    },
  };
  return port;
}

/** A fresh folder and its hands; `processes: true` gives them a computer's process port. */
export function localHands({ maxExecS = 600, processes = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kernel-registry-"));
  const at = (path) => resolve(root, path);
  const hands = {
    maxExecS,
    async stat(path) {
      try {
        const info = await lstat(at(path));
        return { kind: info.isSymbolicLink() ? "link" : info.isDirectory() ? "dir" : "file", size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        return undefined;
      }
    },
    async read(path, range = {}) {
      const bytes = new Uint8Array(await readFile(at(path)));
      const start = range.offset ?? 0;
      return bytes.subarray(start, range.length === undefined ? undefined : start + range.length);
    },
    async write(path, bytes) {
      mkdirSync(dirname(at(path)), { recursive: true });
      await writeFile(at(path), bytes);
    },
    async append(path, bytes) {
      await appendFile(at(path), bytes);
    },
    async list(path) {
      return (await readdir(at(path), { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file", size: 0 }));
    },
    async grep() {
      return "";
    },
    exec(command, options, signal) {
      return new Promise((done, fail) => {
        const child = spawn("bash", ["-c", command], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, stdio: ["ignore", "pipe", "pipe"], signal });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutS * 1000);
        child.stdout.on("data", (data) => options.onOutput?.({ stream: "stdout", data: data.toString("utf8") }));
        child.stderr.on("data", (data) => options.onOutput?.({ stream: "stderr", data: data.toString("utf8") }));
        child.on("error", (error) => {
          clearTimeout(timer);
          fail(error);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          done({ exitCode: code, signal: signal ?? null, timedOut });
        });
      });
    },
    ...(processes ? { processes: localProcesses(root) } : {}),
  };
  return { root, hands };
}

/** Waits until `done()` holds, or fails naming `what`. */
export async function until(done, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
