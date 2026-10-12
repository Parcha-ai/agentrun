// A VisionEnv over Node's file system and child processes for the video suites: files are read and written where the
// test runs, programs run by argv with no shell, and an environment can be wrapped to see what a call derives.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error: Object.assign(error instanceof Error ? error : new Error(String(error)), { code: String(error?.code ?? "EUNKNOWN") }) });
const attempt = async (body) => { try { return ok(await body()); } catch (error) { return fail(error); } };
const info = async (path) => { const s = await stat(path); return { name: path.split("/").at(-1), path, kind: s.isDirectory() ? "directory" : "file", size: s.size, mtimeMs: s.mtimeMs }; };

export function nodeEnv(id = "node-test") {
  return {
    id,
    cwd: process.cwd(),
    readBinaryFile: (path) => attempt(async () => new Uint8Array(await readFile(path))),
    openBinaryReader: (path) => attempt(async () => {
      const handle = await open(path, "r");
      return {
        info: () => attempt(() => info(path)),
        read: (offset, length) => attempt(async () => { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, offset); return new Uint8Array(buffer.subarray(0, bytesRead)); }),
        close: () => handle.close(),
      };
    }),
    writeFile: (path, content) => attempt(() => writeFile(path, content)),
    renameFile: (from, to) => attempt(() => rename(from, to)),
    createDir: (path, options) => attempt(() => mkdir(path, { recursive: options?.recursive ?? false })),
    createTempDir: (prefix) => attempt(() => mkdtemp(join(tmpdir(), prefix ?? "pi-vision-env-"))),
    fileInfo: (path) => attempt(() => info(path)),
    remove: (path, options) => attempt(() => rm(path, { recursive: options?.recursive ?? false, force: options?.force ?? false })),
    // A program that ran and failed is a result with its exit code; one that could not start is an error, as pi's is.
    // The timeout is in seconds, as pi's environments take it.
    exec: (command, options, context) => new Promise((resolve) => {
      const [file, ...args] = Array.isArray(command) ? command : ["sh", "-c", command];
      execFile(file, args, { cwd: options?.cwd, env: { ...process.env, ...options?.env }, timeout: options?.timeout === undefined ? undefined : options.timeout * 1000, signal: context?.abortSignal }, (error) => {
        if (!error) resolve(ok({ exitCode: 0 }));
        else if (typeof error.code === "number") resolve(ok({ exitCode: error.code }));
        else resolve(fail(error));
      });
    }),
  };
}

/** `env` with every file a program leaves in `dir` counted once at the largest size it had: what a call derived. */
export function measured(env, dir) {
  const largest = new Map();
  const sweep = async () => {
    for (const name of await readdir(dir)) {
      const key = name.replace(/\.part$/, "");
      largest.set(key, Math.max(largest.get(key) ?? 0, (await stat(join(dir, name))).size));
    }
  };
  return {
    env: { ...env, exec: async (...args) => { const result = await env.exec(...args); await sweep(); return result; } },
    derivedBytes: () => [...largest.values()].reduce((sum, size) => sum + size, 0),
    derivedNames: () => [...largest.keys()],
  };
}
