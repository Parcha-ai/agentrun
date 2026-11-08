// A fake attachable computer (serve/src/workspace/attach.ts) for the attach tests: a computerd client (the computer
// module's ComputerClient: call(method, params), bytes in base64) over a bind of the host folder `root` at /workspace,
// written with plain node:fs and never fsynced (as computerd writes into a bind); exec.run answers what the test
// scripts; process calls answer ok. It records every call, in order, as [method, params], so a test can show what an
// attached Workspace asked the computer for, without the computer module's daemon.
import { appendFileSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const ok = (value) => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, error: { code, message } });
const CODES = { ENOENT: "not_found", EISDIR: "is_dir", ENOTDIR: "not_dir", EEXIST: "exists", ENOTEMPTY: "invalid", EACCES: "denied" };
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

/**
 * root: the host folder the computer binds at /workspace.
 * options.readBack: what readBack() answers (a value, or a Result to answer as is); default the bind of root.
 * options.page: the most entries one files.list returns. options.chunk: the most bytes one files.read returns.
 * options.exec: (params) => the exec.run value with stdout and stderr as bytes, default an exit 0 with no output.
 * options.onRead: called after each files.read (a test replaces the file between chunks there).
 */
export function fakeComputer(root, options = {}) {
  const calls = [];
  const chunk = options.chunk ?? 512 * 1024;
  const host = (path) => {
    if (path !== "/workspace" && !path.startsWith("/workspace/")) throw new Error(`the fake computer was asked for ${path}, outside /workspace`);
    return join(root, path.slice("/workspace".length));
  };
  const statOf = (stats) => ({ type: stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : stats.isDirectory() ? "dir" : "other", size: stats.size, mode: stats.mode & 0o7777, mtimeMs: stats.mtimeMs, uid: stats.uid, gid: stats.gid });
  const methods = {
    "files.read": ({ path, offset = 0, length = chunk }) => {
      const fd = openSync(host(path), "r");
      try {
        const size = lstatSync(host(path)).size;
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, chunk, size - offset)));
        const got = buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, offset);
        return { data: b64(buffer.subarray(0, got)), eof: offset + got >= size, size };
      } finally {
        closeSync(fd);
        options.onRead?.({ path, offset, length });
      }
    },
    // As computerd's: appended, or opened (truncated, unless at an offset), then the mode set, then the bytes written.
    "files.write": ({ path, data, mode, parents, offset, append }) => {
      if (parents) mkdirSync(dirname(host(path)), { recursive: true });
      const bytes = Buffer.from(data, "base64");
      if (append) {
        appendFileSync(host(path), bytes);
      } else {
        const fd = openSync(host(path), offset === undefined ? "w" : "r+");
        try {
          if (mode !== undefined) fchmodSync(fd, mode);
          writeSync(fd, bytes, 0, bytes.length, offset ?? 0);
        } finally {
          closeSync(fd);
        }
      }
      return { size: lstatSync(host(path)).size };
    },
    "files.list": ({ path, offset = 0 }) => {
      const names = readdirSync(host(path)).sort();
      const page = options.page ?? names.length;
      const entries = names.slice(offset, offset + page).map((name) => ({ path: `${path}/${name}`, ...statOf(lstatSync(join(host(path), name))) }));
      return { entries, truncated: offset + page < names.length };
    },
    "files.mkdir": ({ path, parents }) => { mkdirSync(host(path), { recursive: Boolean(parents) }); return {}; },
    "files.move": ({ from, to }) => { renameSync(host(from), host(to)); return {}; },
    "files.remove": ({ path, recursive }) => {
      if (!lstatSync(host(path)).isDirectory()) unlinkSync(host(path));
      else if (recursive) rmSync(host(path), { recursive: true });
      else rmdirSync(host(path));
      return {};
    },
    "files.stat": ({ path }) => statOf(lstatSync(host(path))),
    "exec.run": (params) => {
      const ran = options.exec?.(params) ?? { exitCode: 0, stdout: new Uint8Array(0), stderr: new Uint8Array(0), timedOut: false, truncated: false };
      return { ...ran, stdout: b64(ran.stdout), stderr: b64(ran.stderr) };
    },
    "process.start": () => ({ id: "p1", pid: 42 }),
    "process.read": () => ({ data: b64(Buffer.from("out")), nextOffset: 3, dropped: 0, exited: true }),
    "process.write": () => ({}),
    "process.signal": () => ({}),
    "process.wait": () => ({ running: false, exitCode: 0, signal: null }),
    "process.list": () => ({ processes: [], truncated: false, next: 0 }),
  };
  const computer = {
    id: "fake-1",
    calls,
    client: {
      async call(method, params) {
        calls.push([method, params]);
        const handler = computer.overrides[method] ?? methods[method];
        if (!handler) return fail("unsupported", `the fake computer has no ${method}`);
        try {
          return "ok" in (handler.result ?? {}) ? handler.result : ok(handler(params));
        } catch (error) {
          return fail(CODES[error.code] ?? "invalid", error.message);
        }
      },
      close() {},
    },
    /** A test's answers in place of a method's: overrides[method] = (params) => value, or { result } to answer as is. */
    overrides: {},
    async readBack() {
      calls.push(["readBack", undefined]);
      const back = options.readBack ?? { kind: "bind", path: root };
      return "ok" in back ? back : ok(back);
    },
    /** Test seams: plant a file or a link in the bound folder, as the computer's own programs could. */
    plant: {
      file: (path, data) => { mkdirSync(dirname(host(path)), { recursive: true }); writeFileSync(host(path), data); },
      link: (path) => { mkdirSync(dirname(host(path)), { recursive: true }); symlinkSync("/etc", host(path)); },
    },
    /** The calls made, by method name only. */
    methods: () => calls.map(([method]) => method),
    clear: () => { calls.length = 0; },
  };
  return computer;
}
