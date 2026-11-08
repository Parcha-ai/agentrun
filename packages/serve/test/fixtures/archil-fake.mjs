// A fake Archil disk behind ArchilDisk (serve/src/workspace/archil-disk.ts), in memory, for ArchilWorkspace's tests.
// It answers the way the disk's file API and serverless exec do, as far as the SDK, Archil's docs and one live run on
// a dev disk showed:
// - a disk is a filesystem: a file where a directory has to be, or a directory where a file is put, is refused (a 400;
//   the real code is not documented, and the workspace does not read it);
// - a put or an append is invisible until it is acknowledged: the bytes are staged, the call waits on `hold` (a promise
//   a test can keep pending), and only then are they committed, at once, and the call resolves;
// - a ranged read takes the Range header itself ("bytes=a-b"): 206 with the slice, 416 past the end;
// - an append takes at most 1 MiB a call (400 EntityTooLarge above it);
// - a listing comes in pages of `pageSize` entries: one level under a "/" delimiter, or, recursive, every FILE key
//   flat, with no directory in it (so a folder holding nothing is not seen that way);
// - symbolic links (only an exec can make one), as the live run showed: a link lists as an object (a file), a GET of
//   it answers 501 NotImplemented, a GET through a linked folder 404, a put or an append through one 409 ("an existing
//   object blocks the path"), and nothing is listed under one; a DELETE of a link removes the link only;
// - grep runs the pattern (JavaScript's regex standing in for ripgrep's) in a worker, stops at maxResults
//   ("max_results") or at maxDurationSeconds ("deadline"), skips binary files and links, reads globs as ripgrep does,
//   and returns its matches in no useful order (reversed here), as the real one returns a sample;
// - exec mounts ONLY its subdirectory: it runs the command line with /bin/sh as a local child, in its own process group,
//   killed when the line ends (the container's end), on a temporary folder holding just the subdirectory's keys at the
//   place /mnt/archil/<mount> names; what that folder holds afterwards replaces the subdirectory (files, folders and
//   links), and nothing else on the disk changes. The subdirectory must be a folder; while an exec holds it, a put, an
//   append or a delete under it is refused with 409, as the service refuses a write to a path another client holds.
//   `banner` (a test's) is printed before the command's own stdout, as a platform's message would be.
// Every call is recorded in `calls`: { op, key | prefix | directory | subdirectory, ... }; every exec's materialized
// file keys (relative to its subdirectory) in `materialized`.
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

export const APPEND_MAX = 1024 * 1024;

export class FakeDiskError extends Error {
  constructor(status, code, message) {
    super(`${status} ${code}: ${message}`);
    this.name = "FakeDiskError";
    this.status = status;
    this.code = code;
  }
}

const parentsOf = (key) => {
  const parts = key.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

/** ripgrep's -g rule, as far as these tests need it: a glob with no "/" is matched against the file's name, one with a
 *  "/" against its path from the directory searched; `[…]` is a class, `{a,b}` alternatives, and a backslash takes the
 *  next character as itself. */
function globMatches(glob, rel) {
  let out = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "\\" && i + 1 < glob.length) out += glob[++i].replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
    else if (c === "[" && glob.indexOf("]", i + 1) !== -1) {
      const end = glob.indexOf("]", i + 1);
      out += `[${glob.slice(i + 1, end).replace(/\\/g, "\\\\")}]`;
      i = end;
    } else if (c === "{") { braces++; out += "(?:"; }
    else if (c === "}" && braces > 0) { braces--; out += ")"; }
    else if (c === "," && braces > 0) out += "|";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${out}$`);
  return regex.test(glob.includes("/") ? rel : rel.split("/").at(-1));
}

const GREP_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const regex = new RegExp(workerData.pattern);
for (const file of workerData.files) {
  const lines = file.text.split("\\n");
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((text, i) => { if (regex.test(text)) parentPort.postMessage({ file: file.key, line: i + 1, text }); });
}
parentPort.postMessage({ done: true });
`;

export class FakeArchilDisk {
  id = "dsk-00000000000fake0";
  /** key -> bytes */
  files = new Map();
  /** directory keys (no trailing "/") */
  dirs = new Set();
  /** key -> link target */
  links = new Map();
  calls = [];
  pageSize = 2;
  /** While set, a put or an append waits on it before it is committed. */
  hold = undefined;
  /** Printed before every exec's own stdout, when set. */
  banner = undefined;
  /** The paths each running exec holds. */
  #held = new Set();
  /** What exec spawned: [file, args]. */
  spawned = [];
  /** Each exec's materialized file keys, relative to its subdirectory. */
  materialized = [];

  #record(call) { this.calls.push(call); }

  #isHeld(key) {
    for (const path of this.#held) if (key === path || key.startsWith(`${path}/`)) return true;
    return false;
  }

  #refuseHeld(key) {
    if (this.#isHeld(key)) throw new FakeDiskError(409, "Conflict", `${key} is checked out by another client`);
  }

  /** A link on the way to `key` (not `key` itself): Archil answers a write through it 409. */
  #linkOnTheWay(key) {
    return parentsOf(key).find((parent) => this.links.has(parent));
  }

  /** `key` may be a file: no directory there, and no file or link on the way to it. */
  #checkFile(key) {
    const link = this.#linkOnTheWay(key);
    if (link !== undefined) throw new FakeDiskError(409, "OperationAborted", `Cannot create the object: an existing object at /${link} blocks the path. Delete or rename it first.`);
    if (this.dirs.has(key)) throw new FakeDiskError(400, "InvalidRequest", `${key} is a directory`);
    for (const parent of parentsOf(key)) if (this.files.has(parent)) throw new FakeDiskError(400, "InvalidRequest", `${parent} is not a directory`);
  }

  #makeParents(key) {
    for (const parent of parentsOf(key)) this.dirs.add(parent);
  }

  async #ack() {
    while (this.hold !== undefined) await this.hold;
  }

  async getRange(key, range) {
    this.#record({ op: "getRange", key, range });
    if (this.links.has(key)) throw new FakeDiskError(501, "NotImplemented", "Not Implemented");
    const bytes = this.files.get(key);
    if (bytes === undefined) throw new FakeDiskError(404, "NoSuchKey", `${key} is not there`);
    const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
    if (!match) throw new FakeDiskError(400, "InvalidRange", range);
    const start = Number(match[1]);
    const end = match[2] === undefined ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
    if (start >= bytes.length) return { status: 416, body: new Uint8Array(0) };
    return { status: 206, body: Uint8Array.from(bytes.subarray(start, end + 1)) };
  }

  async putObject(key, body) {
    this.#record({ op: "putObject", key, size: body.length });
    this.#refuseHeld(key.replace(/\/$/, ""));
    const staged = Uint8Array.from(body);
    if (key.endsWith("/")) {
      const dir = key.slice(0, -1);
      const link = this.#linkOnTheWay(dir) ?? (this.links.has(dir) ? dir : undefined);
      if (link !== undefined) throw new FakeDiskError(409, "OperationAborted", `Cannot create the object: an existing object at /${link} blocks the path. Delete or rename it first.`);
      if (this.files.has(dir)) throw new FakeDiskError(400, "InvalidRequest", `${dir} is a file`);
      for (const parent of parentsOf(dir)) if (this.files.has(parent)) throw new FakeDiskError(400, "InvalidRequest", `${parent} is not a directory`);
      await this.#ack();
      this.#makeParents(dir);
      this.dirs.add(dir);
      return;
    }
    if (this.links.has(key)) throw new FakeDiskError(409, "OperationAborted", `Cannot create the object: an existing object at /${key} blocks the path. Delete or rename it first.`);
    this.#checkFile(key);
    await this.#ack();
    this.#checkFile(key);
    this.#makeParents(key);
    this.files.set(key, staged);
  }

  async appendObject(key, body) {
    this.#record({ op: "appendObject", key, size: body.length, head: Buffer.from(body.subarray(0, 8)).toString("latin1") });
    if (body.length > APPEND_MAX) throw new FakeDiskError(400, "EntityTooLarge", `an append takes at most ${APPEND_MAX} bytes`);
    this.#refuseHeld(key);
    if (this.links.has(key)) throw new FakeDiskError(409, "OperationAborted", `Cannot create the object: an existing object at /${key} blocks the path. Delete or rename it first.`);
    this.#checkFile(key);
    const staged = Uint8Array.from(body);
    await this.#ack();
    this.#makeParents(key);
    const before = this.files.get(key) ?? new Uint8Array(0);
    this.files.set(key, Buffer.concat([before, staged]));
  }

  async deleteObject(key) {
    this.#record({ op: "deleteObject", key });
    if (key.endsWith("/")) {
      const dir = key.slice(0, -1);
      this.#refuseHeld(dir);
      if (!this.dirs.has(dir)) return;
      const prefix = `${dir}/`;
      const inside = [...this.files.keys(), ...this.dirs, ...this.links.keys()].some((k) => k.startsWith(prefix));
      if (inside) throw new FakeDiskError(400, "DirectoryNotEmpty", `${dir} is not empty`);
      this.dirs.delete(dir);
      return;
    }
    this.#refuseHeld(key);
    // A link is removed, never what it points at.
    this.files.delete(key);
    this.links.delete(key);
  }

  async deleteObjects(keys) {
    const errors = [];
    for (const key of keys) {
      try {
        await this.deleteObject(key);
      } catch (error) {
        errors.push({ key, code: error.code, message: error.message });
      }
    }
    return errors;
  }

  async listPage(prefix, { recursive = false, token } = {}) {
    this.#record({ op: "listPage", prefix, recursive, token });
    const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
    // A link is an object; a folder is a "<key>/" entry one level down. A recursive listing is every file key, flat.
    const keys = recursive
      ? [...this.files.keys(), ...this.links.keys()].sort(byBytes)
      : [...this.files.keys(), ...this.links.keys(), ...[...this.dirs].map((d) => `${d}/`)].sort(byBytes);
    const entries = [];
    const seen = new Set();
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const cut = key.indexOf("/", prefix.length);
      if (!recursive && cut !== -1) {
        const common = key.slice(0, cut + 1);
        if (!seen.has(common)) { seen.add(common); entries.push({ prefix: common }); }
        continue;
      }
      entries.push({ key, size: this.files.get(key)?.length ?? this.links.get(key)?.length ?? 0 });
    }
    const start = token === undefined ? 0 : Number(token);
    const page = entries.slice(start, start + this.pageSize);
    const next = start + this.pageSize < entries.length ? String(start + this.pageSize) : undefined;
    return {
      objects: page.filter((e) => e.key !== undefined).map(({ key, size }) => ({ key, size })),
      commonPrefixes: page.filter((e) => e.prefix !== undefined).map((e) => e.prefix),
      ...(next === undefined ? {} : { next }),
    };
  }

  async grep(request) {
    this.#record({ op: "grep", ...request });
    const { directory, pattern, recursive, maxResults, maxDurationSeconds, globs } = request;
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new FakeDiskError(400, "ValidationError", `bad pattern: ${error.message}`);
    }
    const base = directory === "" ? "" : `${directory}/`;
    const files = [...this.files.entries()]
      .filter(([key]) => key.startsWith(base) && (recursive || !key.slice(base.length).includes("/")))
      .filter(([key]) => !globs?.length || globs.some((glob) => globMatches(glob, key.slice(base.length))))
      .filter(([, bytes]) => !Buffer.from(bytes.subarray(0, 8000)).includes(0))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, bytes]) => ({ key, text: Buffer.from(bytes).toString("utf8") }));
    return new Promise((resolve) => {
      const matches = [];
      const worker = new Worker(GREP_WORKER, { eval: true, workerData: { pattern, files } });
      let reason;
      const stop = (why) => { if (reason === undefined) { reason = why; void worker.terminate(); } };
      const timer = setTimeout(() => stop("deadline"), maxDurationSeconds * 1000);
      worker.on("message", (message) => {
        if (message.done) { stop("completed"); return; }
        if (reason !== undefined) return;
        matches.push(message);
        if (matches.length >= maxResults) stop("max_results");
      });
      worker.on("exit", () => { clearTimeout(timer); resolve({ matches: matches.reverse(), stoppedReason: reason ?? "incomplete" }); });
    });
  }

  /** The subdirectory's keys written out under `mount`; the file keys written, relative to the subdirectory. */
  #materialize(mount, sub) {
    const base = `${sub}/`;
    const written = [];
    for (const dir of [...this.dirs].sort()) if (dir.startsWith(base)) mkdirSync(join(mount, dir.slice(base.length)), { recursive: true });
    for (const [key, bytes] of this.files) {
      if (!key.startsWith(base)) continue;
      const rel = key.slice(base.length);
      mkdirSync(dirname(join(mount, rel)), { recursive: true });
      writeFileSync(join(mount, rel), bytes);
      written.push(rel);
    }
    for (const [key, target] of this.links) {
      if (!key.startsWith(base)) continue;
      const rel = key.slice(base.length);
      mkdirSync(dirname(join(mount, rel)), { recursive: true });
      symlinkSync(target, join(mount, rel));
    }
    return written.sort();
  }

  /** The subdirectory replaced by what `mount` holds: links kept as links, never followed; the rest of the disk kept. */
  #absorb(mount, sub) {
    const base = `${sub}/`;
    for (const map of [this.files, this.links]) for (const key of [...map.keys()]) if (key.startsWith(base)) map.delete(key);
    for (const dir of [...this.dirs]) if (dir.startsWith(base)) this.dirs.delete(dir);
    const walk = (abs, rel) => {
      for (const name of readdirSync(abs)) {
        const key = `${rel}/${name}`;
        const stats = lstatSync(join(abs, name));
        if (stats.isSymbolicLink()) this.links.set(key, readlinkSync(join(abs, name)));
        else if (stats.isDirectory()) { this.dirs.add(key); walk(join(abs, name), key); }
        else if (stats.isFile()) this.files.set(key, readFileSync(join(abs, name)));
      }
    };
    walk(mount, sub);
  }

  async exec(request) {
    this.#record({ op: "exec", mount: request.mount, subdirectory: request.subdirectory, checkoutPaths: request.checkoutPaths, queueMs: request.queueMs, image: request.image, command: request.command });
    const sub = request.subdirectory;
    if (typeof sub !== "string" || sub === "") throw new FakeDiskError(400, "ValidationError", "this fake mounts a subdirectory only");
    if (!this.dirs.has(sub)) throw new FakeDiskError(400, "ValidationError", `mount of ${sub}: no such directory`);
    if (this.#isHeld(sub)) throw new FakeDiskError(400, "ValidationError", `mount of ${sub}: delegation queue expired`);
    this.#held.add(sub);
    const mount = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "archil-fake-mnt-"));
    try {
      this.materialized.push(this.#materialize(mount, sub));
      const line = request.command.replaceAll(`/mnt/archil/${request.mount}`, mount);
      const args = ["-c", line];
      this.spawned.push(["/bin/sh", args]);
      const answer = await new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", args, { cwd: "/", env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        const out = [];
        const err = [];
        child.stdout.on("data", (c) => out.push(c));
        child.stderr.on("data", (c) => err.push(c));
        child.on("error", reject);
        child.on("close", (code) => {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
          resolve({ exitCode: code ?? 137, stdout: (this.banner ?? "") + Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
        });
      });
      this.#absorb(mount, sub);
      return answer;
    } finally {
      this.#held.delete(sub);
      rmSync(mount, { recursive: true, force: true });
    }
  }
}
