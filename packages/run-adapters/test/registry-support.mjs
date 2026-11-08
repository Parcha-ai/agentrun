// A run's hands on a local folder, for the kernel registry's tests: files under `root`, commands run by `bash -lc` in
// `root` with TMPDIR set to a directory of this run's own (the background tools keep their box-only copies there).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { appendFile, lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** A fresh folder and its hands. */
export function localHands({ maxExecS = 600 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kernel-registry-"));
  const tmp = join(root, ".tmp");
  mkdirSync(tmp);
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
        const child = spawn("bash", ["-c", command], { cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmp }, stdio: ["ignore", "pipe", "pipe"], signal });
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
  };
  return { root, tmp, hands };
}

/** Waits until `done()` holds, or fails naming `what`. */
export async function until(done, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
