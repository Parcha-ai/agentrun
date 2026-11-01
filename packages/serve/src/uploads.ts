// Uploads: a file reserved (POST /v2/files), its bytes sent (PUT /v2/files/{file_id}), and the ready files a run names
// (`file_ids`) copied into its workspace before its process starts. Each file is `<data>/files/<file_id>/`: its bytes
// (`bytes`) and its record (`file.json`, the contract's File), both 0600, the record written whole. A ready file's bytes
// never change, and a run gets a copy of them, never a link: nothing a run does reaches the upload, and the run's file
// reads (workspace.ts) refuse a file with a second link.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { readJson, tempOf, writeDurable } from "./files.js";
import { ID, type Json } from "./validate.js";

/** `limits.max_upload_bytes`: the largest file a reservation names and a PUT sends. */
export const MAX_UPLOAD_BYTES = 50 * 2 ** 20;
/** `limits.max_files_per_run`: the most files one run names (the contract's `RunCreate.file_ids` takes at most 100). */
export const MAX_FILES_PER_RUN = 20;
/** Where a run finds its files: `work/inputs/<path>`, each file's `path` with its folders. */
export const INPUTS_DIR = "inputs";
/** The data directory's folder of uploads. */
export const UPLOADS_DIR = "files";
const RECORD = "file.json";
const BYTES = "bytes";
/** How long the answer to a reservation says its upload URL lasts. Nothing refuses a later PUT yet: no upload is deleted. */
const UPLOAD_WINDOW_MS = 86_400_000;
/** The longest name one path segment takes on disk (NAME_MAX), in bytes. */
const NAME_MAX = 255;
const SHA256 = /^[0-9a-f]{64}$/;
const FIELDS = ["path", "size_bytes", "content_type", "sha256"];

/** The contract's File: `pending` until its bytes arrive, then `ready`, its `sha256` the bytes' own. */
export type UploadedFile = {
  file_id: string;
  path: string;
  size_bytes: number;
  content_type: string;
  sha256: string | null;
  status: "pending" | "ready";
  created_at: string;
  expires_at: null;
};

/** A UUIDv7, the form of the agent store's agent and run ids: 48 bits of Unix milliseconds, then random bits, so ids
 *  sort by creation time. The store mints its own inside it and exports no minter. */
function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Why `path` is not the contract's FilePathString (relative, `/` between segments, no empty segment and none that starts
 *  with `.`, no backslash or NUL, at most 1024 characters), or a segment is longer than a name on disk; undefined when it
 *  is one. */
export function pathProblem(path: string): string | undefined {
  if (path.length === 0 || [...path].length > 1024) return "path is 1 to 1024 characters";
  if (path.includes("\\") || path.includes("\0")) return "path holds a backslash or a NUL";
  const segments = path.split("/");
  if (segments.some((s) => s === "")) return "path has an empty segment: a leading, trailing or double /";
  if (segments.some((s) => s.startsWith("."))) return "path has a segment that starts with . (., .. or a dot-name)";
  if (segments.some((s) => Buffer.byteLength(s) > NAME_MAX)) return `path has a segment longer than ${NAME_MAX} bytes`;
  return undefined;
}

/** `name` for the first, then `name-2`, `name-3`, ... before its extension (`report-2.pdf`), its stem cut to fit a name
 *  on disk. */
export function suffixed(name: string, n: number): string {
  if (n === 1) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  let stem = [...(dot > 0 ? name.slice(0, dot) : name)];
  while (stem.length > 1 && Buffer.byteLength(`${stem.join("")}-${n}${ext}`) > NAME_MAX) stem = stem.slice(0, -1);
  return `${stem.join("")}-${n}${ext}`;
}

/** Writes all of `chunk`, or throws: a short write (a disk nearly full) never passes as whole. */
async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  for (let at = 0; at < chunk.length; ) {
    const { bytesWritten } = await handle.write(chunk, at, chunk.length - at);
    if (bytesWritten <= 0) throw new Error(`wrote ${at} of ${chunk.length} bytes`);
    at += bytesWritten;
  }
}

const isFile = (value: Json | null): value is UploadedFile =>
  value !== null && typeof value.file_id === "string" && typeof value.path === "string" && Number.isSafeInteger(value.size_bytes) && typeof value.content_type === "string" && (value.status === "pending" || value.status === "ready");

export class Uploads {
  /** The commit of each file's bytes in progress: one at a time per file, so of two PUTs at once one makes it ready and
   *  the other is checked against it. */
  private readonly commits = new Map<string, Promise<void>>();

  /** `root`: `<data>/files`. */
  constructor(private readonly root: string) {}

  /** The file `id`, or null when there is none. */
  async get(id: string): Promise<UploadedFile | null> {
    if (!ID.test(id)) return null;
    const record = await readJson(join(this.root, id, RECORD));
    return isFile(record) && record.file_id === id ? record : null;
  }

  /** POST /files: the body checked as the contract's FileCreate, then a pending file; with where to send its bytes. */
  async reserve(body: Json): Promise<{ file: UploadedFile; upload: { method: "PUT"; url: string; expires_at: string } }> {
    const issues: InputIssue[] = Object.keys(body).filter((key) => !FIELDS.includes(key)).map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
    if (typeof body.path !== "string") issues.push({ field: "path", reason: body.path === undefined ? "missing" : "wrong_type", message: "path is the file's relative path, a string" });
    if (!(Number.isSafeInteger(body.size_bytes) && (body.size_bytes as number) >= 0)) issues.push({ field: "size_bytes", reason: body.size_bytes === undefined ? "missing" : "wrong_type", message: "size_bytes is the file's length in bytes, an integer 0 or more" });
    if (body.content_type !== undefined && !(typeof body.content_type === "string" && body.content_type.length <= 255)) issues.push({ field: "content_type", reason: typeof body.content_type === "string" ? "too_long" : "wrong_type", message: "content_type is a string of at most 255 characters" });
    if (body.sha256 !== undefined && !(typeof body.sha256 === "string" && SHA256.test(body.sha256))) issues.push({ field: "sha256", reason: typeof body.sha256 === "string" ? "bad_format" : "wrong_type", message: "sha256 is 64 lowercase hex digits" });
    if (issues.length) throw invalid(issues);
    const problem = pathProblem(body.path as string);
    if (problem) throw new ApiError("invalid_file_path", problem);
    if ((body.size_bytes as number) > MAX_UPLOAD_BYTES) throw new ApiError("payload_too_large", `size_bytes is over ${MAX_UPLOAD_BYTES}, this server's largest upload`, { details: { limit: "max_upload_bytes" } });
    const now = Date.now();
    const file: UploadedFile = {
      file_id: uuidv7(now),
      path: body.path as string,
      size_bytes: body.size_bytes as number,
      content_type: (body.content_type as string | undefined) ?? "application/octet-stream",
      sha256: (body.sha256 as string | undefined) ?? null,
      status: "pending",
      created_at: new Date(now).toISOString(),
      expires_at: null,
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, file.file_id), { mode: 0o700 });
    await writeDurable(join(this.root, file.file_id, RECORD), `${JSON.stringify(file)}\n`);
    // Relative to the server URL (`/v2`), as the contract's paths are.
    return { file, upload: { method: "PUT", url: `/files/${file.file_id}`, expires_at: new Date(now + UPLOAD_WINDOW_MS).toISOString() } };
  }

  /** PUT /files/{file_id}: `body` is the bytes, streamed to a file of their own beside the record, never held whole.
   *  Their length must be the reserved `size_bytes` and their hash the reserved `sha256` when one was given (422 at that
   *  field), and they are at most MAX_UPLOAD_BYTES (413). Then they are renamed into place and the file is ready. A
   *  ready file's bytes are checked the same way against its own and kept: the same bytes again change nothing. */
  async receive(id: string, body: AsyncIterable<Buffer>): Promise<UploadedFile> {
    const file = await this.get(id);
    if (!file) throw new ApiError("not_found", `no file ${id}`);
    const dir = join(this.root, id);
    const temp = file.status === "pending" ? tempOf(join(dir, BYTES)) : undefined;
    const handle = temp ? await open(temp, "wx", 0o600) : undefined;
    let closed = false;
    let kept = false;
    try {
      const hash = createHash("sha256");
      let size = 0;
      // An oversized body is read to its end before the refusal, so the client gets the answer and not a reset; only the
      // reserved length is ever written.
      for await (const chunk of body) {
        size += chunk.length;
        hash.update(chunk);
        if (handle && size <= file.size_bytes) await writeAll(handle, chunk);
      }
      if (size > MAX_UPLOAD_BYTES) throw new ApiError("payload_too_large", `the body is over ${MAX_UPLOAD_BYTES} bytes, this server's largest upload`, { details: { limit: "max_upload_bytes" } });
      const sha256 = hash.digest("hex");
      const mismatch = (held: UploadedFile) =>
        size !== held.size_bytes
          ? invalid([{ field: "size_bytes", reason: "invalid", message: `The body is ${size} bytes; the file was reserved with size_bytes ${held.size_bytes}.` }])
          : held.sha256 !== null && held.sha256 !== sha256
            ? invalid([{ field: "sha256", reason: "invalid", message: `The body's SHA-256 is ${sha256}; the file ${held.status === "ready" ? "is ready with" : "was reserved with"} ${held.sha256}.` }])
            : undefined;
      const wrong = mismatch(file);
      if (wrong) throw wrong;
      if (!handle || !temp) return file;
      await handle.sync();
      closed = true;
      await handle.close();
      return await this.exclusive(id, async () => {
        // Read again: another PUT may have made it ready meanwhile, with these bytes or others.
        const now = (await this.get(id)) ?? file;
        if (now.status === "ready") {
          const other = mismatch(now);
          if (other) throw other;
          return now;
        }
        await rename(temp, join(dir, BYTES));
        kept = true;
        const ready: UploadedFile = { ...now, sha256, status: "ready" };
        await writeDurable(join(dir, RECORD), `${JSON.stringify(ready)}\n`);
        return ready;
      });
    } finally {
      if (!closed) await handle?.close().catch(() => undefined);
      if (temp && !kept) await unlink(temp).catch(() => undefined);
    }
  }

  /** `work` in turn for file `id`. The chain holds only settled turns, so one that failed never fails the next. */
  private exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const turn = (this.commits.get(id) ?? Promise.resolve()).then(work);
    const settled = turn.then(() => undefined, () => undefined);
    this.commits.set(id, settled);
    void settled.then(() => {
      if (this.commits.get(id) === settled) this.commits.delete(id);
    });
    return turn;
  }

  /** A run's `file_ids`: each a file that is ready, none twice, at most MAX_FILES_PER_RUN, or 422 at `file_ids`. */
  async readyFiles(ids: readonly unknown[]): Promise<UploadedFile[]> {
    const issues: InputIssue[] = [];
    if (ids.length > MAX_FILES_PER_RUN) issues.push({ field: "file_ids", reason: "too_many", message: `A run names at most ${MAX_FILES_PER_RUN} files here (limits.max_files_per_run); this names ${ids.length}.` });
    else if (new Set(ids).size !== ids.length) issues.push({ field: "file_ids", reason: "duplicate", message: "file_ids names one file twice" });
    if (issues.length) throw invalid(issues);
    const files: UploadedFile[] = [];
    for (const [i, id] of ids.entries()) {
      const field = `file_ids[${i}]`;
      if (typeof id !== "string" || !ID.test(id)) {
        issues.push({ field, reason: "wrong_type", message: `${field} is a file id` });
        continue;
      }
      const file = await this.get(id);
      if (!file) issues.push({ field, reason: "not_an_option", message: `There is no file ${id}: reserve it with POST /files.` });
      else if (file.status !== "ready" || pathProblem(file.path)) issues.push({ field, reason: "invalid", message: `The file ${id} is not ready: send its bytes with PUT /files/${id} first.` });
      else files.push(file);
    }
    if (issues.length) throw invalid(issues);
    return files;
  }

  /** Copies `files` into `work/inputs/`, each at its `path` with its folders, in order, before the run's process exists:
   *  a name taken already (the same path twice, or a file where another's folder goes) gets the next free suffix
   *  (`notes-2.txt`, `docs-2/`), the same for the same files in the same order. Each copy is a new file, made as the
   *  agent store makes a run's skill files (its mode from the umask): never a link to the upload. Answers each copy's path
   *  under `work`. */
  async copyInto(work: string, files: readonly UploadedFile[]): Promise<string[]> {
    const base = join(work, INPUTS_DIR);
    await mkdir(base, { recursive: true });
    const placed: string[] = [];
    for (const file of files) {
      const segments = file.path.split("/");
      let dir = base;
      let rel = INPUTS_DIR;
      for (const segment of segments.slice(0, -1)) {
        const name = await folderIn(dir, segment);
        dir = join(dir, name);
        rel = `${rel}/${name}`;
      }
      const name = await copyIn(dir, segments.at(-1)!, join(this.root, file.file_id, BYTES));
      placed.push(`${rel}/${name}`);
    }
    return placed;
  }
}

/** The folder `name` in `dir`, made or one already there, or the first suffixed name free of a file. */
async function folderIn(dir: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = suffixed(name, n);
    try {
      await mkdir(join(dir, candidate));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if ((await lstat(join(dir, candidate))).isDirectory()) return candidate;
  }
}

/** A copy of `source` in `dir` as `name`, or the first suffixed name nothing holds. Created exclusive, so it is a new
 *  file and never what a name already pointed at. */
async function copyIn(dir: string, name: string, source: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = suffixed(name, n);
    let handle: FileHandle;
    try {
      handle = await open(join(dir, candidate), "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    await pipeline(createReadStream(source), handle.createWriteStream());
    return candidate;
  }
}
