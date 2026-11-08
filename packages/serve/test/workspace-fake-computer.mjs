// A fake Computer (serve/src/workspace/attach.ts) for the attach tests: an in-memory folder of absolute paths, an exec
// that answers what the test scripts, and process calls that answer ok. It records every call, in order, as
// [method, params], so a test can show what an attached Workspace asked the computer for, without module D.
const ok = (value) => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, error: { code, message } });
const parentOf = (path) => path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * options.readBack: what readBack() answers (a value, or a ComputerResult to answer as is).
 * options.chunk: the most bytes one files.read returns (computerd's chunk), default 512 KiB.
 * options.exec: (params) => the exec.run value, default an exit 0 with no output.
 */
export function fakeComputer(options = {}) {
  const calls = [];
  const files = new Map();
  const dirs = new Set(["/", "/workspace"]);
  const links = new Map();
  const chunk = options.chunk ?? 512 * 1024;
  const record = (method, params) => calls.push([method, params]);
  const typeOf = (path) => (links.has(path) ? "symlink" : files.has(path) ? "file" : dirs.has(path) ? "dir" : undefined);
  const makeParents = (path) => {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) dirs.add(`/${parts.slice(0, i).join("/")}`);
  };
  const computer = {
    id: "fake-1",
    calls,
    files: {
      async read(params) {
        record("files.read", params);
        const data = files.get(params.path);
        if (data === undefined) return dirs.has(params.path) ? fail("is_dir", "is a directory") : fail("not_found", "no such file");
        const offset = params.offset ?? 0;
        const slice = data.subarray(offset, offset + Math.min(params.length ?? chunk, chunk));
        return ok({ data: slice, eof: offset + slice.length >= data.length, size: data.length });
      },
      async write(params) {
        record("files.write", params);
        if (params.parents) makeParents(params.path);
        if (!dirs.has(parentOf(params.path))) return fail("not_found", "no parent folder");
        files.set(params.path, Buffer.from(params.data));
        return ok({ size: params.data.length });
      },
      async append(params) {
        record("files.append", params);
        if (params.parents) makeParents(params.path);
        if (!dirs.has(parentOf(params.path))) return fail("not_found", "no parent folder");
        files.set(params.path, Buffer.concat([files.get(params.path) ?? Buffer.alloc(0), params.data]));
        return ok({ size: files.get(params.path).length });
      },
      async list(params) {
        record("files.list", params);
        if (!dirs.has(params.path)) return fail(files.has(params.path) ? "not_dir" : "not_found", "not a folder");
        const prefix = params.path === "/" ? "/" : `${params.path}/`;
        const below = (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
        const entries = [
          ...[...files].filter(([path]) => below(path)).map(([path, data]) => ({ path, type: "file", size: data.length, mode: 0o644 })),
          ...[...dirs].filter(below).map((path) => ({ path, type: "dir", size: 4096, mode: 0o755 })),
          ...[...links.keys()].filter(below).map((path) => ({ path, type: "symlink", size: 0, mode: 0o777 })),
        ].sort((a, b) => (a.path < b.path ? -1 : 1));
        const page = options.page ?? entries.length;
        const offset = params.offset ?? 0;
        return ok({ entries: entries.slice(offset, offset + page), truncated: offset + page < entries.length });
      },
      async mkdir(params) {
        record("files.mkdir", params);
        if (files.has(params.path)) return fail("exists", "a file is there");
        makeParents(params.path);
        dirs.add(params.path);
        return ok({});
      },
      async move(params) {
        record("files.move", params);
        const data = files.get(params.from);
        if (data === undefined) return fail("not_found", "nothing to move");
        files.delete(params.from);
        files.set(params.to, data);
        return ok({});
      },
      async remove(params) {
        record("files.remove", params);
        if (links.delete(params.path) || files.delete(params.path)) return ok({});
        if (!dirs.has(params.path)) return fail("not_found", "nothing there");
        const inside = [...files.keys(), ...dirs].filter((path) => path.startsWith(`${params.path}/`));
        if (inside.length > 0 && !params.recursive) return fail("invalid", "the folder is not empty");
        for (const path of inside) { files.delete(path); dirs.delete(path); }
        dirs.delete(params.path);
        return ok({});
      },
      async stat(params) {
        record("files.stat", params);
        const type = typeOf(params.path);
        if (type === undefined) return fail("not_found", "nothing there");
        return ok({ type, size: files.get(params.path)?.length ?? 0, mode: type === "file" ? 0o640 : 0o755 });
      },
    },
    exec: {
      async run(params) {
        record("exec.run", params);
        return ok(options.exec?.(params) ?? { exitCode: 0, stdout: new Uint8Array(0), stderr: new Uint8Array(0), timedOut: false, truncated: false });
      },
    },
    process: {
      async start(params) { record("process.start", params); return ok({ id: "p1", pid: 42 }); },
      async read(params) { record("process.read", params); return ok({ data: Buffer.from("out"), nextOffset: 3, dropped: 0, exited: true }); },
      async write(params) { record("process.write", params); return ok({}); },
      async signal(params) { record("process.signal", params); return ok({}); },
      async wait(params) { record("process.wait", params); return ok({ running: false, exitCode: 0, signal: null }); },
      async list(params) { record("process.list", params); return ok({ processes: [], truncated: false, next: 0 }); },
    },
    async readBack() {
      record("readBack", undefined);
      const back = options.readBack;
      return back && "ok" in back ? back : ok(back);
    },
    /** Test seams: plant a file, a folder or a link, as the computer's own programs could. */
    plant: {
      file: (path, data) => { makeParents(path); files.set(path, Buffer.from(data)); },
      link: (path) => { makeParents(path); links.set(path, "/etc"); },
    },
    /** The calls made, by method name only. */
    methods: () => calls.map(([method]) => method),
    clear: () => { calls.length = 0; },
  };
  return computer;
}
