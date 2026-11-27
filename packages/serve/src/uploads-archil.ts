// Uploads in Mode 2 (Archil settings set): kept on the server's own Archil disk, never on its data directory, and copied
// into a run's folder by the server when it starts the run, so a runner reads no upload and needs no disk of the server's.
//
// - The uploads disk: one per server, named agentrun-<server id>-files (uploadsDiskName; an agent's is
//   agentrun-<server id>-i-<agent id>, workspace/run-disk.ts), made by the first upload (POST /v2/files) and found by
//   name after. Reads (GET, DELETE, a run's file_ids) never make it: with none there, this server keeps no file.
// - Each file is files/<file_id>/ on it, as Mode 1 keeps <data>/files/<file_id>/ (uploads.ts): its bytes (`bytes`) and
//   its record (`file.json`, the contract's File), the record written after the bytes, so a file with no record is none.
//   Each run started with it leaves a mark, files/<file_id>/runs/<run id> (the time it was made), which retention reads.
// - At a run's start with file_ids (placeRunFiles), before its row is written: the run's disk is resolved as its claim
//   resolves it (workspace/run-disk.ts runDiskOf: the launch's, else its agent's, made when the agent has none), and each
//   file is copied into the run's folder at work/inputs/<path> as a claim copies it in Mode 1 (uploads.ts
//   copyFilesInto), PLACE_CONCURRENCY at a time across every start on the server, all within PLACE_TIMEOUT_MS. A copy
//   that fails, or runs past that, refuses the start in words, and what it wrote is removed. The launch then says so
//   (RunLaunch.filesPlaced) and names the disk, so the claim mounts that disk and copies nothing.
// - Retention (sweepUploads): a file older than the retention (AGENTRUN_UPLOAD_RETENTION, default 7d; "off" keeps every
//   file) that no run in the store names is deleted. A mark of a run the store no longer has, or keeps only as a deleted
//   run's tombstone (runKeepsUploads), does not count, but a mark younger than MARK_GRACE_MS does: its run may be
//   starting now, its row not yet written.
//
// Mode 1 is uploads.ts alone, unchanged.
import { type ArchilSettings, loadArchilSettings, serverIdOf } from "./archil-settings.js";
import { ApiError, invalid } from "./errors.js";
import type { KeyEnv } from "./key-meta.js";
import type { LaunchDisk, RunLaunch } from "./run-launch.js";
import type { Store } from "./store/index.js";
import { serialBy } from "./files.js";
import { createHash } from "node:crypto";
import { ID, type Json } from "./validate.js";
import { ArchilClaimRefused } from "./workspace/archil-claim.js";
import { type ArchilDisk, type ArchilDiskOptions, archilDisk } from "./workspace/archil-disk.js";
import { availableDisk, diskNamed, ensureDisk } from "./workspace/archil-disks.js";
import { archilApiKey } from "./workspace/archil-key.js";
import type { ArchilControlOptions } from "./workspace/archil-mount-credential.js";
import { archilWorkspace } from "./workspace/archil.js";
import { agentDirName, runKey } from "./workspace/paths.js";
import { runDiskOf } from "./workspace/run-disk.js";
import { isWorkspaceError, type Workspace, WorkspaceError } from "./workspace/index.js";
import {
  answerOf, copyFilesInto, type FileRecord, fileSeen, type FileUploadAnswer, recordText, INPUTS_DIR, isUploadedFile, MAX_FILES_PER_RUN, MAX_UPLOAD_BYTES, mismatchOf, pathProblem, readyFilesOf, type Received, reservation, sentInOneCall, slots,
  type UploadedFile, type UploadStore,
} from "./uploads.js";
import { uuidv7 } from "./ids.js";
import { workspaceNow } from "./workspace-scope.js";

/** The folder of the uploads disk the files are kept under. */
export const UPLOADS_KEY = "files";
const RECORD = "file.json";
const BYTES = "bytes";
/** Each file's marks of the runs started with it. */
const MARKS = "runs";
/** How many files the server copies into run folders at once, across every start: its one HTTP/2 connection to
 *  Archil's S3 host carries them all, and with 3 or more 10 MiB writes in flight Archil's gateway resets their streams
 *  (NGHTTP2_ENHANCE_YOUR_CALM), measured live. Two at a time copied 20 files of 10 MiB in 11 to 14 s. */
export const PLACE_CONCURRENCY = 2;
/** How long a start may spend copying its files (and making its agent's disk, when it has none) before it is refused:
 *  well inside a client's read timeout of a start (grep reads one for 90 s). */
export const PLACE_TIMEOUT_MS = 45_000;
/** A mark younger than this keeps its file whether or not its run is in the store yet. */
export const MARK_GRACE_MS = 60 * 60_000;
/** The retention of uploaded files no run names, when AGENTRUN_UPLOAD_RETENTION is not set: 7 days. */
export const DEFAULT_UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const UPLOAD_RETENTION_ENV = "AGENTRUN_UPLOAD_RETENTION";
/** How often the server sweeps the uploads disk. */
export const UPLOAD_SWEEP_EVERY_MS = 60 * 60_000;
/** The longest key Archil's S3 gateway takes, in bytes. */
const KEY_MAX = 1024;
/** A run's copy of a file on its disk at most: the agent's folder name (agentDirName: up to 128 characters, a dash and 16
 *  hex digits), a run id of up to 128 characters, and room for a suffix on each segment (uploads.ts copyFilesInto). */
const RUN_KEY_ROOM = `agents/${"x".repeat(128 + 17)}/runs/${"x".repeat(128)}/work/${INPUTS_DIR}/`;
const SUFFIX_ROOM = `-${MAX_FILES_PER_RUN + 1}`.length;

/** The uploads disk's name: agentrun-<server id>-files. No agent's disk is named so (diskNameOf: -i- or -h- before the
 *  agent's part). */
export const uploadsDiskName = (serverId: string): string => `agentrun-${serverId}-files`;

/** AGENTRUN_UPLOAD_RETENTION as milliseconds: a whole number and a unit (ms, s, m, h, d), or "off" (undefined: every file
 *  is kept). Not set: DEFAULT_UPLOAD_RETENTION_MS. Anything else throws, naming the variable. */
export function uploadRetentionMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return DEFAULT_UPLOAD_RETENTION_MS;
  if (value.trim() === "off") return undefined;
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!m || Number(m[1]) <= 0) throw new Error(`${UPLOAD_RETENTION_ENV} is ${JSON.stringify(value)}: give a duration such as 7d, 36h or 90m, or "off"`);
  return Number(m[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms" | "s" | "m" | "h" | "d"];
}

/** Why `path` cannot be an upload's path on an Archil disk: not the contract's FilePathString, or a run's copy of it
 *  (agents/<agent>/runs/<run>/work/inputs/<path>, suffixes included) longer than a key Archil takes. */
export function archilPathProblem(path: string): string | undefined {
  const problem = pathProblem(path);
  if (problem) return problem;
  const longest = Buffer.byteLength(`${RUN_KEY_ROOM}${path}`) + path.split("/").length * SUFFIX_ROOM;
  return longest > KEY_MAX ? `path is too long for a run's folder on Archil: a run's copy of it would take a key of up to ${longest} bytes, over ${KEY_MAX}` : undefined;
}

/** Reads `body` whole, up to MAX_UPLOAD_BYTES kept (the rest read and dropped, so the client gets the refusal, not a
 *  reset): its bytes, its length and its SHA-256. */
async function readBody(body: AsyncIterable<Buffer>, keep: number): Promise<{ bytes: Buffer; size: number; sha256: string }> {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    hash.update(chunk);
    if (size <= keep) chunks.push(chunk);
  }
  return { bytes: size <= keep ? Buffer.concat(chunks, size) : Buffer.alloc(0), size, sha256: hash.digest("hex") };
}

const tooLarge = (): ApiError => new ApiError("payload_too_large", `the body is over ${MAX_UPLOAD_BYTES} bytes, this server's largest upload`, { details: { limit: "max_upload_bytes" } });

/** Uploads kept in a Workspace: `<file_id>/bytes`, `<file_id>/file.json` and `<file_id>/runs/<run id>` at its root (the
 *  uploads disk's files/ folder). The routes' rules are Mode 1's (uploads.ts): the same checks, words and answers. */
export class WorkspaceUploads implements UploadStore {
  /** `commits`: each file's commit or delete in progress, one at a time per file as Mode 1's. Shared by every store over
   *  the same uploads disk (archilUploads keeps one per disk), so two requests on one file take turns. */
  constructor(readonly workspace: Workspace, private readonly commits: Map<string, Promise<unknown>> = new Map()) {}

  private exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    return serialBy(this.commits, id, work);
  }

  async get(id: string): Promise<UploadedFile | null> {
    return fileSeen(await this.kept(id));
  }

  private async kept(id: string): Promise<FileRecord | null> {
    if (!ID.test(id)) return null;
    let text: string;
    try {
      text = Buffer.from(await this.workspace.read(`${id}/${RECORD}`)).toString("utf8");
    } catch (error) {
      if (isWorkspaceError(error, "NOT_FOUND")) return null;
      throw error;
    }
    let record: Json | null;
    try {
      record = JSON.parse(text) as Json;
    } catch {
      return null;
    }
    return isUploadedFile(record) && record.file_id === id ? record : null;
  }

  async ids(): Promise<string[]> {
    const entries = await this.workspace.list("").catch((error: unknown) => {
      if (isWorkspaceError(error, "NOT_FOUND")) return [];
      throw error;
    });
    return entries.filter((entry) => entry.kind === "dir" && ID.test(entry.name)).map((entry) => entry.name).sort().reverse();
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      if (!(await this.get(id))) throw new ApiError("not_found", `no file ${id}: GET /v2/files lists the files this server keeps`);
      await this.workspace.remove(id, { recursive: true, force: true });
    });
  }

  /** A file's folder, gone whole: what a failed make leaves is never a file the API cannot list or delete. */
  private async drop(id: string): Promise<void> {
    await this.workspace.remove(id, { recursive: true, force: true }).catch(() => undefined);
  }

  async take(query: URLSearchParams, requestType: string | undefined, body: AsyncIterable<Buffer>): Promise<Received> {
    const { path, sha, contentType } = sentInOneCall(query, requestType, archilPathProblem);
    const { bytes, size, sha256 } = await readBody(body, MAX_UPLOAD_BYTES);
    if (size > MAX_UPLOAD_BYTES) throw tooLarge();
    if (sha !== null && sha !== sha256) throw invalid([{ field: "sha256", reason: "invalid", message: `The body's SHA-256 is ${sha256}; the query names ${sha}.` }]);
    return {
      fingerprint: { sent_in_one_call: true, path, content_type: contentType, size_bytes: size, sha256 },
      commit: async () => {
        const now = Date.now();
        const file: UploadedFile = { file_id: uuidv7(now), path, size_bytes: size, content_type: contentType, sha256, status: "ready", created_at: new Date(now).toISOString(), expires_at: null };
        try {
          await this.workspace.write(`${file.file_id}/${BYTES}`, bytes);
          await this.workspace.write(`${file.file_id}/${RECORD}`, recordText(file, workspaceNow()));
        } catch (error) {
          await this.drop(file.file_id);
          throw error;
        }
        return answerOf(file);
      },
      // The bytes were never written anywhere but memory.
      discard: async () => undefined,
    };
  }

  async reserve(body: Json): Promise<FileUploadAnswer> {
    const file = reservation(body, archilPathProblem);
    await this.workspace.write(`${file.file_id}/${RECORD}`, recordText(file, workspaceNow()));
    return answerOf(file);
  }

  async receive(id: string, body: AsyncIterable<Buffer>): Promise<UploadedFile> {
    const file = await this.get(id);
    if (!file) throw new ApiError("not_found", `no file ${id}`);
    const { bytes, size, sha256 } = await readBody(body, file.status === "pending" ? file.size_bytes : 0);
    if (size > MAX_UPLOAD_BYTES) throw tooLarge();
    const wrong = mismatchOf(file, size, sha256);
    if (wrong) throw wrong;
    return await this.exclusive(id, async () => {
      // Read again: another PUT may have made it ready meanwhile, or a DELETE removed it.
      const record = await this.kept(id);
      const now = fileSeen(record);
      if (!now) throw new ApiError("not_found", `no file ${id}: it was deleted while its bytes arrived`);
      if (now.status === "ready") {
        const other = mismatchOf(now, size, sha256);
        if (other) throw other;
        return now;
      }
      await this.workspace.write(`${id}/${BYTES}`, bytes);
      const ready: UploadedFile = { ...now, sha256, status: "ready" };
      await this.workspace.write(`${id}/${RECORD}`, recordText(ready, record?.workspace));
      return ready;
    });
  }

  readyFiles(ids: readonly unknown[]): Promise<UploadedFile[]> {
    return readyFilesOf(ids, async (id) => fileSeen(await this.kept(id), true), archilPathProblem);
  }

  /** File `file`'s bytes. */
  async bytes(file: UploadedFile): Promise<Uint8Array> {
    return await this.workspace.read(`${file.file_id}/${BYTES}`);
  }

  /** Marks each of `ids` as named by run `runId`, at `now`. */
  async mark(ids: readonly string[], runId: string, now = Date.now()): Promise<void> {
    await Promise.all(ids.map((id) => this.workspace.write(`${id}/${MARKS}/${runId}`, `${JSON.stringify({ at: new Date(now).toISOString() })}\n`)));
  }

  /** Whether a run keeps file `id`: a mark of a run the store has (`hasRun`), or one younger than MARK_GRACE_MS. */
  private async named(id: string, hasRun: (runId: string) => Promise<boolean>, now: number): Promise<boolean> {
    const marks = await this.workspace.list(`${id}/${MARKS}`).catch((error: unknown) => {
      if (isWorkspaceError(error, "NOT_FOUND")) return [];
      throw error;
    });
    for (const mark of marks) {
      if (mark.kind !== "file" || !ID.test(mark.name)) continue;
      const at = await this.workspace.read(`${id}/${MARKS}/${mark.name}`).then((raw) => Date.parse((JSON.parse(Buffer.from(raw).toString("utf8")) as { at?: string }).at ?? ""), () => Number.NaN);
      // A mark whose time can't be read is taken as new: a file is kept while a run might be starting with it.
      if (!(now - at >= MARK_GRACE_MS)) return true;
      if (await hasRun(mark.name)) return true;
    }
    return false;
  }

  /** Deletes each file made more than `retentionMs` before `now` that no run keeps (named): the ids deleted. A file a
   *  record can't be read for (a make that failed between its bytes and its record) is deleted once its folder is that
   *  old by the id's own time (a UUIDv7's milliseconds). */
  async sweep(retentionMs: number, hasRun: (runId: string) => Promise<boolean>, now = Date.now()): Promise<string[]> {
    const deleted: string[] = [];
    for (const id of await this.ids()) {
      const made = await this.get(id).then((file) => (file ? Date.parse(file.created_at) : timeOfId(id)), () => Number.NaN);
      if (!(now - made > retentionMs)) continue;
      if (await this.named(id, hasRun, now)) continue;
      await this.exclusive(id, async () => {
        await this.workspace.remove(id, { recursive: true, force: true });
        deleted.push(id);
      });
    }
    return deleted;
  }
}

/** The time a UUIDv7 id was made at (its first 48 bits), or NaN for another id. */
function timeOfId(id: string): number {
  const hex = id.replace(/-/g, "");
  return /^[0-9a-f]{32}$/.test(hex) && hex[12] === "7" ? Number.parseInt(hex.slice(0, 12), 16) : Number.NaN;
}

export interface ArchilUploadsOptions {
  /** The server's store: its settings (the Archil settings, the server's id, each agent's disk) and sealed keys. */
  readonly store: Pick<Store, "settings" | "sealedKeys">;
  readonly sealKey: Buffer | undefined;
  /** The server's environment: ARCHIL_API_KEY and the Archil settings there win over the saved ones. */
  readonly env?: KeyEnv;
  /** A test's control plane and maker of a disk's file API (server.ts archilControl). */
  readonly control?: { readonly baseUrl?: string; readonly fetch?: typeof fetch; readonly makeDisk?: (options: ArchilDiskOptions) => ArchilDisk };
  /** How long a start may spend placing its files (default PLACE_TIMEOUT_MS). */
  readonly placeTimeoutMs?: number;
}

/** What a start with files gets from placeRunFiles: its launch, saying its files are placed and naming its disk, and how
 *  to undo the placing when its row is not written. */
export interface Placed {
  readonly launch: RunLaunch;
  undo(): Promise<void>;
}

/** Whether run `runId` keeps the uploads it was started with, for retention (sweep's hasRun): the store has it and it
 *  was not deleted. A deleted run's row stays as a tombstone (purgedAt set), which keeps no upload. */
export const runKeepsUploads = (store: { runs: { get(runId: string): Promise<{ readonly purgedAt: number | null } | undefined> } }) =>
  async (runId: string): Promise<boolean> => {
    const run = await store.runs.get(runId);
    return run !== undefined && run.purgedAt === null;
  };

/** Mode 2's uploads for one server: the uploads store (`here`), a start's placing of its files (`place`), and the sweep.
 *  Every call reads the Archil settings first: with none (Mode 1), `here` and `place` answer undefined, and the caller
 *  uses uploads.ts. */
export function archilUploads(options: ArchilUploadsOptions) {
  const { store, sealKey, env = {} } = options;
  /** The uploads disk's id by the settings it was found under (its region, S3 URL and account key), once found or made. */
  const disks = new Map<string, string>();
  /** Each uploads disk's per-file turns (WorkspaceUploads commits), by its id: one map for every request on it. */
  const turns = new Map<string, Map<string, Promise<unknown>>>();
  /** The copy slots every start's placing shares (PLACE_CONCURRENCY). */
  const copying = slots(PLACE_CONCURRENCY);
  const turnsOf = (diskId: string): Map<string, Promise<unknown>> => {
    let held = turns.get(diskId);
    if (!held) turns.set(diskId, (held = new Map()));
    return held;
  };

  /** The settings and the account key, or undefined in Mode 1. A key that can't be read is 503 in words naming what to
   *  save, never a value. */
  async function opened(): Promise<{ settings: ArchilSettings; key: string; control: ArchilControlOptions } | undefined> {
    const settings = await loadArchilSettings(store, env);
    if (settings === undefined) return undefined;
    let key: string;
    try {
      key = (await archilApiKey({ env, keys: store.sealedKeys, sealKey })).value;
    } catch (error) {
      throw new ApiError("unavailable", `This server keeps uploads on Archil, and its Archil key can't be read: ${(error as Error).message}`);
    }
    const control: ArchilControlOptions = { region: settings.region, key: () => key, ...(options.control?.baseUrl ? { baseUrl: options.control.baseUrl } : {}), ...(options.control?.fetch ? { fetch: options.control.fetch } : {}) };
    return { settings, key, control };
  }

  const diskOf = (settings: ArchilSettings, key: string, diskId: string): ArchilDisk =>
    (options.control?.makeDisk ?? archilDisk)({ disk: diskId, region: settings.region, s3BaseUrl: settings.s3Url, key: () => key });

  /** The uploads disk's id: found by its name, or made when `make` (the first upload); undefined when it is not there and
   *  not to be made. Archil's refusal is 424 in its words, the key scrubbed. */
  async function uploadsDiskId(settings: ArchilSettings, key: string, control: ArchilControlOptions, make: boolean): Promise<string | undefined> {
    // By the account too (a hash of its key, never the key): a key of another account in the same region has its own
    // uploads disk, which is looked up again, never the old account's id.
    const at = `${settings.region} ${settings.s3Url} ${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
    const known = disks.get(at);
    if (known !== undefined) return known;
    const name = uploadsDiskName(await serverIdOf(store));
    try {
      // Two first uploads at once both make it: Archil's make is idempotent by name (archil-disks.ts ensureDisk).
      const there = await diskNamed(control, name);
      if (there === undefined && !make) return undefined;
      const id = there?.id ?? (await ensureDisk(control, name)).id;
      if (there?.status !== "available") await availableDisk(control, id, { timeoutMs: options.placeTimeoutMs ?? PLACE_TIMEOUT_MS });
      disks.set(at, id);
      return id;
    } catch (error) {
      throw new ApiError("upstream_failed", `This server's uploads disk ${name} on Archil can't be ${make ? "made or read" : "read"}: ${String((error as Error)?.message ?? error).split(key).join("[the key]")}`);
    }
  }

  /** The uploads store in Mode 2, undefined in Mode 1. `make`: an upload, which makes the uploads disk when there is none;
   *  otherwise, with none, a store of no files. */
  async function here(make: boolean): Promise<WorkspaceUploads | undefined> {
    const open = await opened();
    if (open === undefined) return undefined;
    const diskId = await uploadsDiskId(open.settings, open.key, open.control, make);
    return diskId === undefined ? new WorkspaceUploads(emptyWorkspace) : new WorkspaceUploads(archilWorkspace(diskOf(open.settings, open.key, diskId), UPLOADS_KEY), turnsOf(diskId));
  }

  /** In Mode 2, run `runId`'s files (`launch.files`, checked ready) copied into its folder before its row is written: its
   *  disk resolved as its claim resolves it, then each file at work/inputs/<path>, and each marked as the run's. Undefined
   *  in Mode 1 (the claim copies them, uploads.ts). A disk that can't be had, a file that can't be read or written, or a
   *  copy past the time allowed refuses the start in words (424), what it wrote removed. */
  async function place(runId: string, agentId: string, launch: RunLaunch): Promise<Placed | undefined> {
    const ids = launch.files ?? [];
    if (!ids.length) return undefined;
    const open = await opened();
    if (open === undefined) return undefined;
    const timeoutMs = options.placeTimeoutMs ?? PLACE_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    const refused = (why: string): ApiError => new ApiError("upstream_failed", `The run's files could not be copied into its folder on Archil, so it was not started: ${why.split(open.key).join("[the key]")}`);
    const late = `it took longer than ${timeoutMs / 1000} s`;
    /** The run's folder's parent on its disk, once the disk is resolved: what undo removes the run's folder from. */
    let runs: Workspace | undefined;
    let disk: { diskId: string; kind: "launch" | "agent" } | undefined;
    // All of the placing (the records read, the run's disk, the marks, the copy) is one piece of work, raced against the
    // deadline: the start answers by then whatever a call to Archil is still waiting on.
    const work = (async () => {
      const uploads = (await here(false))!;
      const files = await uploads.readyFiles(ids);
      try {
        // The claim's resolver, without the run (its row is not written yet): the disk then rides the launch, so every
        // claim of the run mounts this one.
        disk = await runDiskOf({ store, agentId, ...(launch.archilDisk ? { launch: launch.archilDisk } : {}), control: open.control, signal, availableMs: timeoutMs });
      } catch (error) {
        throw refused(error instanceof ArchilClaimRefused ? error.message : signal.aborted ? `its disk was not ready: ${late}` : String((error as Error)?.message ?? error));
      }
      signal.throwIfAborted();
      const runDisk = diskOf(open.settings, open.key, disk.diskId);
      runs = archilWorkspace(runDisk, `agents/${agentDirName(agentId)}/runs`, { queueMs: 5_000 });
      await uploads.mark(ids, runId);
      await copyFilesInto(archilWorkspace(runDisk, runKey(agentId, runId)), files, (file) => uploads.bytes(file), { concurrency: PLACE_CONCURRENCY, turn: copying, signal });
    })();
    /** Removes what the placing wrote, once every read and write it started has settled, so none lands after. */
    const undo = async (): Promise<void> => {
      await work.catch(() => undefined);
      await runs?.remove(runId, { recursive: true, force: true }).catch(() => undefined);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
      // A copy that ended just as the deadline passed is late all the same: its start has been given up on.
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) {
        // Answered now; what is still in flight is removed once it settles.
        void undo();
        throw refused(`the copy of its files: ${late}`);
      }
      await undo();
      throw error instanceof ApiError ? error : refused(String((error as Error)?.message ?? error));
    }
    const launchDisk: LaunchDisk = launch.archilDisk ?? { diskId: disk!.diskId, kind: disk!.kind };
    return { launch: { ...launch, archilDisk: launchDisk, filesPlaced: true }, undo };
  }

  /** One sweep of the uploads disk (WorkspaceUploads.sweep), in Mode 2 with the disk there: the ids deleted. */
  async function sweep(retentionMs: number, hasRun: (runId: string) => Promise<boolean>, now = Date.now()): Promise<string[]> {
    const uploads = await here(false);
    return uploads === undefined ? [] : await uploads.sweep(retentionMs, hasRun, now);
  }

  return { here, place, sweep };
}

export type ArchilUploads = ReturnType<typeof archilUploads>;

const noDisk = async (): Promise<never> => {
  throw new WorkspaceError("REFUSED", "this server has made no uploads disk yet: its first upload makes it");
};

/** The uploads store's folder while the uploads disk is not made: nothing in it, and nothing written to it. */
const emptyWorkspace: Workspace = {
  read: async (path) => {
    throw new WorkspaceError("NOT_FOUND", `${path} is not there: this server has made no uploads disk yet`, { path });
  },
  stat: async () => undefined,
  list: async () => [],
  grep: noDisk,
  write: noDisk,
  append: noDisk,
  mkdir: noDisk,
  remove: async () => undefined,
  exec: noDisk,
  process: { start: noDisk, read: noDisk, write: noDisk, signal: noDisk, wait: noDisk, list: noDisk },
  mountSpec: noDisk,
  attach: noDisk,
};
