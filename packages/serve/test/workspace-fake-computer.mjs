// A fake Computer (serve/src/workspace/attach.ts) for the attach tests: a bind of the host folder `root` at /workspace,
// written with plain node:fs and never fsynced (as computerd writes into a bind), an exec that answers what the test
// scripts, and process calls that answer ok. It records every call, in order, as [method, params], so a test can show
// what an attached Workspace asked the computer for, without module D.
import { appendFileSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const ok = (value) => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, error: { code, message } });
const CODES = { ENOENT: "not_found", EISDIR: "is_dir", ENOTDIR: "not_dir", EEXIST: "exists", ENOTEMPTY: "invalid", EACCES: "denied" };

/**
 * root: the host folder the computer binds at /workspace.
 * options.readBack: what readBack() answers (a value, or a ComputerResult to answer as is); default the bind of root.
 * options.page: the most entries one files.list returns. options.chunk: the most bytes one files.read returns.
 * options.exec: (params) => the exec.run value, default an exit 0 with no output.
 * options.onRead: called after each files.read (a test replaces the file between chunks there).
 */
export function fakeComputer(root, options = {}) {
  const calls = [];
  const chunk = options.chunk ?? 512 * 1024;
  const host = (path) => {
    if (path !== "/workspace" && !path.startsWith("/workspace/")) throw new Error(`the fake computer was asked for ${path}, outside /workspace`);
    return join(root, path.slice("/workspace".length));
  };
  const call = (method, run) => async (params) => {
    calls.push([method, params]);
    try {
      return ok(run(params));
    } catch (error) {
      return fail(CODES[error.code] ?? "invalid", error.message);
    }
  };
  const statOf = (stats) => ({ type: stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : stats.isDirectory() ? "dir" : "other", size: stats.size, mode: stats.mode & 0o7777, mtimeMs: stats.mtimeMs });
  const computer = {
    id: "fake-1",
    calls,
    files: {
      read: call("files.read", ({ path, offset = 0, length = chunk }) => {
        const fd = openSync(host(path), "r");
        try {
          const size = lstatSync(host(path)).size;
          const buffer = Buffer.alloc(Math.max(0, Math.min(length, chunk, size - offset)));
          const got = buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, offset);
          return { data: buffer.subarray(0, got), eof: offset + got >= size, size };
        } finally {
          closeSync(fd);
          options.onRead?.({ path, offset, length });
        }
      }),
      // As computerd's: opened (truncated, unless at an offset), then the mode set, then the bytes written.
      write: call("files.write", ({ path, data, mode, parents, offset }) => {
        if (parents) mkdirSync(dirname(host(path)), { recursive: true });
        const fd = openSync(host(path), offset === undefined ? "w" : "r+");
        try {
          if (mode !== undefined) fchmodSync(fd, mode);
          writeSync(fd, data, 0, data.length, offset ?? 0);
        } finally {
          closeSync(fd);
        }
        return { size: lstatSync(host(path)).size };
      }),
      append: call("files.append", ({ path, data, parents }) => {
        if (parents) mkdirSync(dirname(host(path)), { recursive: true });
        appendFileSync(host(path), data);
        return { size: lstatSync(host(path)).size };
      }),
      list: call("files.list", ({ path, offset = 0 }) => {
        const names = readdirSync(host(path)).sort();
        const page = options.page ?? names.length;
        const entries = names.slice(offset, offset + page).map((name) => ({ path: `${path}/${name}`, ...statOf(lstatSync(join(host(path), name))) }));
        return { entries, truncated: offset + page < names.length };
      }),
      mkdir: call("files.mkdir", ({ path, parents }) => { mkdirSync(host(path), { recursive: Boolean(parents) }); return {}; }),
      move: call("files.move", ({ from, to }) => { renameSync(host(from), host(to)); return {}; }),
      remove: call("files.remove", ({ path, recursive }) => {
        if (!lstatSync(host(path)).isDirectory()) unlinkSync(host(path));
        else if (recursive) rmSync(host(path), { recursive: true });
        else rmdirSync(host(path));
        return {};
      }),
      stat: call("files.stat", ({ path }) => statOf(lstatSync(host(path)))),
    },
    exec: {
      run: call("exec.run", (params) => options.exec?.(params) ?? { exitCode: 0, stdout: new Uint8Array(0), stderr: new Uint8Array(0), timedOut: false, truncated: false }),
    },
    process: {
      start: call("process.start", () => ({ id: "p1", pid: 42 })),
      read: call("process.read", () => ({ data: Buffer.from("out"), nextOffset: 3, dropped: 0, exited: true })),
      write: call("process.write", () => ({})),
      signal: call("process.signal", () => ({})),
      wait: call("process.wait", () => ({ running: false, exitCode: 0, signal: null })),
      list: call("process.list", () => ({ processes: [], truncated: false, next: 0 })),
    },
    async readBack() {
      calls.push(["readBack", undefined]);
      const back = options.readBack ?? { kind: "bind", at: "/workspace", path: root };
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
