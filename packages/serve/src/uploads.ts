// Uploads: a file reserved (POST /v2/files) and its bytes sent (PUT /v2/files/{file_id}), or sent in one call (POST
// /v2/files?path=..., the bytes the body); listed, read and deleted; and the ready files a run names (`file_ids`) copied
// into its workspace before its process starts. Each file is `<data>/files/<file_id>/`: its bytes
// (`bytes`) and its record (`file.json`, the contract's File), both 0600, the record written whole. A ready file's bytes
// never change, and a run gets a copy of them through its Workspace, never a link: nothing a run does reaches the upload.
import { createHash, randomBytes } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { DISK_DIR } from "@parcha/pi-durable-agent";
import { dirname, join } from "node:path";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { typeOf } from "./file-types.js";
import { readJson, serialBy, tempOf, writeDurable } from "./files.js";
import { ID, type Json, unknownFields } from "./validate.js";
import { type Entry, isWorkspaceError, type Workspace, workspaceAt } from "./workspace/index.js";

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
/** The `upload.expires_at` the answer to a reservation gives, which the contract requires: advisory, not enforced in this
 *  release. A later PUT is still taken, and nothing deletes an upload. */
const UPLOAD_WINDOW_MS = 86_400_000;
/** The longest name one path segment takes on disk (NAME_MAX), in bytes. */
const NAME_MAX = 255;
/** The longest path the system opens (PATH_MAX), in bytes with its NUL: 1024 on macOS, 4096 elsewhere. */
const PATH_MAX = process.platform === "darwin" ? 1024 : 4096;
/** A run id's room in a run's copy of a file: a UUIDv7's 36 characters. */
const RUN_ID_ROOM = "x".repeat(36);
/** An agent's folder's room on the disk: an id of up to 128 characters, a dash and 16 hex digits (agentDirName). */
const AGENT_DIR_ROOM = "x".repeat(128 + 17);
/** The room a run's copy may add to each segment: a suffix, at most one past the most files a run names. */
const SUFFIX_ROOM = `-${MAX_FILES_PER_RUN + 1}`.length;
const SHA256 = /^[0-9a-f]{64}$/;
/** The temp files this module writes, by their exact names (files.ts tempOf: `<name>.<pid>.<12 hex digits>.tmp`): a file
 *  sent in one call, as its bytes arrive, under the root; a PUT's bytes, in its file's folder. */
const INCOMING_TEMP = /^\.incoming\.\d+\.[0-9a-f]{12}\.tmp$/;
const BYTES_TEMP = /^bytes\.\d+\.[0-9a-f]{12}\.tmp$/;
const FIELDS = ["path", "size_bytes", "content_type", "sha256"];
/** What a file sent in one call takes in the query: its path, and when given its type and the hash its bytes must have. */
const QUERY = ["path", "content_type", "sha256"];
/** A request's types that say only "bytes", never the file's own: curl's `--data-binary` default and octet-stream. */
const GENERIC_TYPES = new Set(["application/octet-stream", "application/x-www-form-urlencoded"]);
/** Where a file's bytes go: its own PUT, as a path from the server's root, so it resolves against the server's address
 *  as given (`http://host:port`) or as the contract's `/v2` server URL alike. */
export const uploadUrl = (id: string): string => `/v2/files/${id}`;

/** Test seams, tests only: as a run's copy starts, with the run's Workspace, before any file is copied; and as a file
 *  sent in one call writes its record, with the file's folder, its bytes in place. */
export const uploadTestHooks: { beforeCopy?: (workspace: Workspace) => Promise<void> | void; beforeRecord?: (dir: string) => Promise<void> | void } = {};

/** The contract's FileUpload: the file, and where to send its bytes (for a file sent in one call, ready, a PUT of the
 *  same bytes, which changes nothing). */
export type FileUploadAnswer = { file: UploadedFile; upload: { method: "PUT"; url: string; expires_at: string } };

/** A file sent in one call, its bytes in and checked, before it is made: `fingerprint` is what an Idempotency-Key is
 *  matched on (its path, type, length and hash), `commit` makes it, ready, and `discard` drops the bytes of one not made. */
export type Received = { fingerprint: Json; commit(): Promise<FileUploadAnswer>; discard(): Promise<void> };

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

/** What a request sent, as its JSON (a string quoted), cut to 40 characters (an ellipsis the 40th when it is longer):
 *  by code points, so a surrogate pair is never split. A value JSON.stringify cannot write (nested past the stack, as a
 *  parsed body can be) is named as such: describing a bad value never fails the refusal. */
const shown = (value: unknown): string => {
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    return "a value too deep to show";
  }
  const chars = [...json];
  return chars.length > 40 ? `${chars.slice(0, 39).join("")}\u2026` : chars.join("");
};

/** `name` for the first, then `name-2`, `name-3`, ... before its extension (`report-2.pdf`), cut to fit a name on disk:
 *  its stem first, down to one character, then its extension. */
export function suffixed(name: string, n: number): string {
  if (n === 1) return name;
  const dot = name.lastIndexOf(".");
  let stem = [...(dot > 0 ? name.slice(0, dot) : name)];
  let ext = [...(dot > 0 ? name.slice(dot) : "")];
  const fits = () => Buffer.byteLength(`${stem.join("")}-${n}${ext.join("")}`) <= NAME_MAX;
  while (!fits() && stem.length > 1) stem = stem.slice(0, -1);
  while (!fits() && ext.length > 0) ext = ext.slice(0, -1);
  return `${stem.join("")}-${n}${ext.join("")}`;
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
  private readonly commits = new Map<string, Promise<unknown>>();

  /** `root`: `<data>/files`. */
  constructor(private readonly root: string) {}

  /** Why `path` cannot be a file's path here: not the contract's FilePathString, a segment longer than a name on disk,
   *  or a run's copy of it (`<data>/runs/<run id>/work/inputs/<path>`, room for a suffix on each segment included) longer
   *  than a path the system opens. Undefined when it can. */
  private problemOf(path: string): string | undefined {
    const problem = pathProblem(path);
    if (problem) return problem;
    const longest = Buffer.byteLength(join(dirname(this.root), DISK_DIR, "agents", AGENT_DIR_ROOM, "runs", RUN_ID_ROOM, "work", INPUTS_DIR, path)) + path.split("/").length * SUFFIX_ROOM + 1;
    return longest > PATH_MAX ? `path is too long for this server's disk: a run's copy of it would take up to ${longest} bytes, over ${PATH_MAX}` : undefined;
  }

  /** The file `id`, or null when there is none. */
  async get(id: string): Promise<UploadedFile | null> {
    if (!ID.test(id)) return null;
    const record = await readJson(join(this.root, id, RECORD));
    return isFile(record) && record.file_id === id ? record : null;
  }

  /** Every file's id, newest first: a UUIDv7 sorts by its time. The files' list reads them a page at a time. */
  async ids(): Promise<string[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    return names.filter((name) => ID.test(name)).sort().reverse();
  }

  /** At a start, under the data directory's lock (one server per data directory, so no PUT of this server is in flight):
   *  removes the temp files a crash left, by the exact names this module writes them under. That is `.incoming.*.tmp`
   *  under the root, and `bytes.*.tmp` in a folder named as a file's id. Each goes only when lstat says it is a regular
   *  file: a link or anything else named like one stays, nothing is followed, and only those folders are entered, one
   *  level. A file's bytes and its record are never touched: a folder left with only its temp keeps the rest, as after a
   *  failed PUT. A root that is not a real directory (a link to storage another server may share) is not swept at all: the
   *  lock covers this data directory, not where a link goes. Answers how many it removed. */
  async sweep(): Promise<number> {
    if (!(await lstat(this.root).catch(() => null))?.isDirectory()) return 0;
    let removed = 0;
    const drop = async (path: string) => {
      if (!(await lstat(path).catch(() => null))?.isFile()) return;
      await unlink(path).then(() => void removed++, () => undefined);
    };
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (INCOMING_TEMP.test(name)) await drop(join(this.root, name));
      else if (ID.test(name) && (await lstat(join(this.root, name)).catch(() => null))?.isDirectory()) {
        for (const inner of await readdir(join(this.root, name)).catch(() => [] as string[])) if (BYTES_TEMP.test(inner)) await drop(join(this.root, name, inner));
      }
    }
    return removed;
  }

  /** Deletes the file `id`, pending or ready, or 404. A run that copied it keeps its copy. In turn with a PUT's commit, so
   *  a PUT that ends after the delete answers 404 and makes nothing. */
  async remove(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      if (!(await this.get(id))) throw new ApiError("not_found", `no file ${id}: GET /v2/files lists the files this server keeps`);
      await rm(join(this.root, id), { recursive: true, force: true });
    });
  }

  /** The answer to a reservation, and to a file sent in one call. `upload.expires_at` is advisory (UPLOAD_WINDOW_MS). */
  private answer(file: UploadedFile): FileUploadAnswer {
    return { file, upload: { method: "PUT", url: uploadUrl(file.file_id), expires_at: new Date(Date.parse(file.created_at) + UPLOAD_WINDOW_MS).toISOString() } };
  }

  /** POST /v2/files?path=...: the body is the file's bytes, whatever its type but a multipart form (415, with the call
   *  that works). The query takes `path`, and `content_type` and `sha256` when given; the length is the body's and the hash
   *  its own. The type is `content_type`, else the request's when it names one (not octet-stream, not curl's form type),
   *  else the path's extension's, else octet-stream. The bytes stream to a dot-named file of their own under the root,
   *  never held whole; over MAX_UPLOAD_BYTES is 413, a `sha256` they do not have 422. Nothing is made until `commit`. */
  async take(query: URLSearchParams, requestType: string | undefined, body: AsyncIterable<Buffer>): Promise<Received> {
    const type = String(requestType ?? "").trim();
    if (/^multipart\//i.test(type)) throw new ApiError("unsupported_media_type", "A multipart form is not taken: send the file's bytes as the body, as `curl --data-binary @plan.md \"$AGENTRUN_BASE_URL/files?path=plan.md\"` does.");
    const issues: InputIssue[] = [...new Set(query.keys())].filter((key) => !QUERY.includes(key)).map((key) => ({ field: key, reason: "not_allowed", message: `A file sent in one call takes path, content_type and sha256 in the query; ${key} is not one.` }));
    for (const key of QUERY) if (query.getAll(key).length > 1) issues.push({ field: key, reason: "duplicate", message: `${key} is given more than once` });
    const path = query.get("path");
    // An empty one is none.
    const named = query.get("content_type") || null;
    const sha = query.get("sha256");
    if (path === null) issues.push({ field: "path", reason: "missing", message: "Name the file: POST /v2/files?path=<its path> with its bytes as the body, or a JSON reservation {path, size_bytes} and then PUT /v2/files/<id>.", fix: "Add ?path=<the file's name> to the URL." });
    if (sha !== null && !SHA256.test(sha)) issues.push({ field: "sha256", reason: "bad_format", message: "sha256 is 64 lowercase hex digits" });
    if (issues.length) throw invalid(issues);
    const problem = this.problemOf(path!);
    if (problem) throw new ApiError("invalid_file_path", problem);
    const given = type && !GENERIC_TYPES.has(type.split(";")[0]!.trim().toLowerCase()) ? type : undefined;
    const contentType = named ?? given ?? typeOf(path!) ?? "application/octet-stream";
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = tempOf(join(this.root, ".incoming"));
    const handle = await open(temp, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      let size = 0;
      // Read to its end, as a PUT's: the client gets the refusal, not a reset; nothing past the limit is written.
      for await (const chunk of body) {
        size += chunk.length;
        hash.update(chunk);
        if (size <= MAX_UPLOAD_BYTES) await writeAll(handle, chunk);
      }
      if (size > MAX_UPLOAD_BYTES) throw new ApiError("payload_too_large", `the body is over ${MAX_UPLOAD_BYTES} bytes, this server's largest upload`, { details: { limit: "max_upload_bytes" } });
      const sha256 = hash.digest("hex");
      if (sha !== null && sha !== sha256) throw invalid([{ field: "sha256", reason: "invalid", message: `The body's SHA-256 is ${sha256}; the query names ${sha}.` }]);
      await handle.sync();
      await handle.close();
      const fingerprint: Json = { sent_in_one_call: true, path: path!, content_type: contentType, size_bytes: size, sha256 };
      let made = false;
      return {
        fingerprint,
        commit: async () => {
          const now = Date.now();
          const file: UploadedFile = { file_id: uuidv7(now), path: path!, size_bytes: size, content_type: contentType, sha256, status: "ready", created_at: new Date(now).toISOString(), expires_at: null };
          const dir = join(this.root, file.file_id);
          await mkdir(dir, { mode: 0o700 });
          try {
            await rename(temp, join(dir, BYTES));
            made = true;
            await uploadTestHooks.beforeRecord?.(dir);
            await writeDurable(join(dir, RECORD), `${JSON.stringify(file)}\n`);
          } catch (error) {
            // No record, no file: its folder and bytes go too, so nothing is left that the API cannot list or delete.
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
            throw error;
          }
          return this.answer(file);
        },
        discard: async () => {
          if (!made) await unlink(temp).catch(() => undefined);
        },
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  /** POST /v2/files: the body checked as the contract's FileCreate, then a pending file; with where to send its bytes. */
  async reserve(body: Json): Promise<FileUploadAnswer> {
    const issues = unknownFields(body, FIELDS);
    if (typeof body.path !== "string") issues.push({ field: "path", reason: body.path === undefined ? "missing" : "wrong_type", message: "path is the file's relative path, a string" });
    if (!(Number.isSafeInteger(body.size_bytes) && (body.size_bytes as number) >= 0)) issues.push({ field: "size_bytes", reason: body.size_bytes === undefined ? "missing" : "wrong_type", message: "size_bytes is the file's length in bytes, an integer 0 or more" });
    if (body.content_type !== undefined && typeof body.content_type !== "string") issues.push({ field: "content_type", reason: "wrong_type", message: "content_type is a string" });
    if (body.sha256 !== undefined && !(typeof body.sha256 === "string" && SHA256.test(body.sha256))) issues.push({ field: "sha256", reason: typeof body.sha256 === "string" ? "bad_format" : "wrong_type", message: "sha256 is 64 lowercase hex digits" });
    if (issues.length) throw invalid(issues);
    const problem = this.problemOf(body.path as string);
    if (problem) throw new ApiError("invalid_file_path", problem);
    if ((body.size_bytes as number) > MAX_UPLOAD_BYTES) throw new ApiError("payload_too_large", `size_bytes is over ${MAX_UPLOAD_BYTES}, this server's largest upload`, { details: { limit: "max_upload_bytes" } });
    const now = Date.now();
    const file: UploadedFile = {
      file_id: uuidv7(now),
      path: body.path as string,
      size_bytes: body.size_bytes as number,
      // Named, or by the path's extension as a run's files are served (`plan.md` is text/markdown), else octet-stream.
      content_type: (body.content_type as string | undefined) ?? typeOf(body.path as string) ?? "application/octet-stream",
      sha256: (body.sha256 as string | undefined) ?? null,
      status: "pending",
      created_at: new Date(now).toISOString(),
      expires_at: null,
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, file.file_id), { mode: 0o700 });
    await writeDurable(join(this.root, file.file_id, RECORD), `${JSON.stringify(file)}\n`);
    return this.answer(file);
  }

  /** PUT /v2/files/{file_id}: `body` is the bytes, streamed to a file of their own beside the record, never held whole.
   *  Their length must be the reserved `size_bytes` and their hash the reserved `sha256` when one was given (422 at that
   *  field), and they are at most MAX_UPLOAD_BYTES (413). Then they are renamed into place and the file is ready. A
   *  ready file's bytes are checked the same way against its own and kept: the same bytes again change nothing. */
  async receive(id: string, body: AsyncIterable<Buffer>): Promise<UploadedFile> {
    const file = await this.get(id);
    if (!file) throw new ApiError("not_found", `no file ${id}`);
    const dir = join(this.root, id);
    const temp = file.status === "pending" ? tempOf(join(dir, BYTES)) : undefined;
    // A DELETE that lands between the read above and this open has taken the folder: the file is gone, a 404. Any other
    // failure of the open stays the server's own.
    const handle = temp
      ? await open(temp, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw new ApiError("not_found", `no file ${id}: it was deleted as its bytes arrived`);
          throw error;
        })
      : undefined;
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
      // Ready already: read again in turn with a DELETE, which may have removed it while these bytes arrived.
      if (!handle || !temp)
        return await this.exclusive(id, async () => {
          const now = await this.get(id);
          if (!now) throw new ApiError("not_found", `no file ${id}: it was deleted while its bytes arrived`);
          const other = mismatch(now);
          if (other) throw other;
          return now;
        });
      await handle.sync();
      closed = true;
      await handle.close();
      return await this.exclusive(id, async () => {
        // Read again: another PUT may have made it ready meanwhile, with these bytes or others, or a DELETE removed it.
        const now = await this.get(id);
        if (!now) throw new ApiError("not_found", `no file ${id}: it was deleted while its bytes arrived`);
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
    return serialBy(this.commits, id, work);
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
        issues.push({ field, reason: "wrong_type", message: `${field} is ${shown(id)}, not a file id: use the file_id an upload answered (POST /v2/files answers it under file.file_id).` });
        continue;
      }
      const file = await this.get(id);
      const problem = file?.status === "ready" ? this.problemOf(file.path) : undefined;
      if (!file) issues.push({ field, reason: "not_an_option", message: `There is no file ${id}: reserve it with POST /v2/files.` });
      else if (file.status !== "ready") issues.push({ field, reason: "invalid", message: `The file ${id} is not ready: send its bytes with PUT /v2/files/${id} first.` });
      else if (problem) issues.push({ field, reason: "invalid", message: `The file ${id} cannot be copied into a run here: ${problem}.` });
      else files.push(file);
    }
    if (issues.length) throw invalid(issues);
    return files;
  }

  /** Copies `files` into the run's `inputs/` through its Workspace, each at its `path` with its folders, in order, before
   *  the run's process exists: a name taken already (the same path twice, a file where another's folder goes, or what
   *  the folder held before) gets the next free suffix (`notes-2.txt`, `docs-2/`), the same for the same files in the
   *  same order. Each copy is a new file written whole by the Workspace, never a link to the upload; a link on the way
   *  fails the copy (ESCAPE), and nothing is written through it. The run's start still hands its folder's path. */
  async copyInto(work: Workspace | string, files: readonly UploadedFile[]): Promise<void> {
    const workspace = workspaceAt(work);
    await uploadTestHooks.beforeCopy?.(workspace);
    const names = takenNames(workspace);
    for (const file of files) {
      const segments = file.path.split("/");
      let dir = INPUTS_DIR;
      for (const segment of segments.slice(0, -1)) dir = `${dir}/${free(await names(dir), segment, "dir")}`;
      const name = free(await names(dir), segments.at(-1)!, "file");
      await workspace.write(`${dir}/${name}`, await readFile(join(this.root, file.file_id, BYTES)));
    }
  }
}

type Kind = Entry["kind"];

/** The names in each folder of `workspace`, by its path, each read once from its listing (none for a folder not there
 *  yet) and kept up to date with what the copy takes. */
function takenNames(workspace: Workspace): (dir: string) => Promise<Map<string, Kind>> {
  const folders = new Map<string, Promise<Map<string, Kind>>>();
  return (dir) => {
    let names = folders.get(dir);
    if (!names) {
      names = workspace.list(dir).then(
        (entries) => new Map(entries.map((entry) => [entry.name, entry.kind])),
        (error: unknown) => {
          if (isWorkspaceError(error, "NOT_FOUND")) return new Map<string, Kind>();
          throw error;
        },
      );
      folders.set(dir, names);
    }
    return names;
  };
}

/** `name`, or its first suffixed form, that `names` leaves free for a `kind`: a folder may go into one already there,
 *  a file only where nothing is. The name is taken in `names`. */
function free(names: Map<string, Kind>, name: string, kind: Kind): string {
  for (let n = 1; ; n++) {
    const candidate = suffixed(name, n);
    const there = names.get(candidate);
    if (there === undefined) {
      names.set(candidate, kind);
      return candidate;
    }
    if (kind === "dir" && there === "dir") return candidate;
  }
}
