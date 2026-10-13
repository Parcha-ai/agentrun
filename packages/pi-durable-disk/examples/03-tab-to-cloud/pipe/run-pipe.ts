// The pipe of one run: it holds the run's claim (the package's lease: exclusive mount, owner lock, run.json heartbeat,
// self-fence) and pi's SqliteStorage on the mount, and serves the tab that runs the agent. It has no agent logic:
//
// - Storage: each Storage call of the tab's Session is one frame, dispatched to the store on the mount. A commit's
//   answer leaves only after SQLite's WAL fsync returned, so the tab never shows what the disk does not have.
// - Workspace write-through: after a tool, the tab sends the files it changed; they are written under work/, the mount
//   is synced (`archil sync`, the claim's barrier) and only then acknowledged, so the tool's result commits after its
//   files are durable. A file past CHUNK_BYTES comes first as an upload, in ordered chunks, into tmp/pipe-uploads/
//   beside work/; the write-through renames it into place only when its size and SHA-256 match.
// - Model calls: proxied to the model endpoint with a per-run token budget; the key never reaches the tab.
// - Restore: on attach, the tab gets work/ as the disk has it: a manifest (each file's size and SHA-256), then the
//   files in chunks, then the end; the tab checks every file against the manifest and says so. The pipe keeps each
//   file's digest under its identity (device, inode, size, mtime and ctime in ns), from the write-through that wrote
//   it or from one read, so an attach reads work/ once: to send it. What it sends is hashed and checked against the
//   manifest again; a file that changed during the attach fails the restore, never passes torn or stale.
//
// One tab writes at a time. A takeover gives the run to a new socket with a new epoch: the old socket is told it lost
// the run and every later frame of it is refused, after the frames it already sent have settled. Nothing of a retired
// writer lands in work/ after that: every rename into work/ checks, in the same turn, that its writer is still current.
// Viewers receive the writer's view events and the placement. A fence (the claim revoked, the mount failed, the lease
// lapsed) ends the pipe: every socket is told, nothing is retried.
import { createHash, randomBytes, type Hash } from "node:crypto";
import { constants, renameSync, type BigIntStats, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { FencedError, openArchilStore, openRunLease, storeHead } from "@parcha/pi-durable-disk";
import type { SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import type { ArchilHost, ArchilStore, OpenRunLeaseOptions, RunLease, RunRef } from "@parcha/pi-durable-disk";
import type { AppPolicy } from "../agent.ts";
import type { ModelProxy } from "./model-proxy.ts";
import {
  CHUNK_BYTES,
  errorToWire,
  fromBase64,
  PipeLostError,
  STORAGE_METHODS,
  tag,
  toBase64,
  untag,
  workspaceDigest,
  lazyPath,
  type Environment,
  type FileChange,
  type FileEntry,
  type ManifestEntry,
  type Move,
  type PipeFrame,
  type StorageMethod,
  type Tagged,
} from "../wire.ts";

/** What the pipe needs of a socket; the server adapts a WebSocket to it. */
export interface PipeSocket {
  readonly id: string;
  send(frame: PipeFrame): void;
  close(code: number, reason: string): void;
  /** Bytes sent and not yet written out; a restore waits while this is high. */
  bufferedAmount?(): number;
  /** False once the socket closed; a restore stops sending. */
  isOpen?(): boolean;
}

export interface RunPipeOptions {
  readonly ref: RunRef;
  readonly mountToken: string;
  readonly mountRoot: string;
  readonly host?: ArchilHost;
  readonly lease?: OpenRunLeaseOptions["lease"];
  /** The run's model access (its budget spans every place the run goes). */
  readonly model: ModelProxy;
  /** The writer is gone once its socket closed or it sent no ping for this long. Default 3 s. */
  readonly writerGraceMs?: number;
  /** Called once when the writer is gone and no other took its place (tab closed, laptop lid shut, network lost). */
  readonly onWriterGone?: (pipe: RunPipe) => void;
  /** Called once when the pipe lost the run (fenced). */
  readonly onLost?: (pipe: RunPipe, error: FencedError) => void;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
  /** An attach refuses a workspace larger than this (its writer has its own limit, often smaller). Default 1 GiB. */
  readonly restoreLimitBytes?: number;
  /**
   * Prefixes of work/ an attach does not send (a large result written by the agent that nothing in the writer needs in its own
   * workspace; a reader fetches it from the disk). They count toward no restore limit, are left out of the attached frame and the
   * restore, and the frame says which they are. Everything else about them (the disk, the digests, the release evidence) is unchanged.
   */
  readonly noRestore?: readonly string[];
  /** What the host tells the page about its agent (instructions, extensions to leave out): sent in the attach, applied where the page creates the root conversation. */
  readonly app?: AppPolicy;
  /** A writer's unfinished uploads together may hold this many bytes; past it, an upload fails. Default 4 GiB. */
  readonly uploadLimitBytes?: number;
  /** A writer may have this many unfinished uploads; an upload past it is refused. Default 1024. */
  readonly maxUnfinishedUploads?: number;
  /** Test seams, passed to the lease. */
  readonly acquire?: OpenRunLeaseOptions["acquire"];
  readonly claimDir?: OpenRunLeaseOptions["claimDir"];
  /** Conformance mode: every writer gets a fresh scratch store under tmp/, opened like the run's. */
  readonly scratchStores?: boolean;
  /** How the attach's log line names work/ (default `manifestDigest`); a test seam. */
  readonly digest?: (entries: readonly ManifestEntry[]) => Promise<string>;
}

type Writer = {
  socket: PipeSocket;
  epoch: number;
  tab: string;
  lastPing: number;
  inflight: Set<Promise<unknown>>;
  dead: boolean;
  /** The tab's Session closed its storage: every later call is refused, as a closed store refuses it. */
  closed: boolean;
  storage: Storage;
  store: ArchilStore;
  attachedAt: number;
  /** Set until `attached` is sent: hashing a large workspace must not count as a silent writer. */
  attaching: boolean;
  /** Upload chunks being written now: a writer whose chunk is still on its way to the disk is not silent. */
  uploading: number;
  /** Set until its restore ended: no write-through into work/ meanwhile, so what it is sent is what the disk holds. */
  restoring: boolean;
  /** The page said its runtime is up (writer-ready): a line sent to it now can run. */
  pageReady: boolean;
  /** Its socket closed: it is declared gone a moment later (a refreshed page can ask for the run in that moment). */
  detached?: boolean;
};

/**
 * A file a writer is uploading: chunks append in order (each waits for the one before), hashed as they land. A chunk out
 * of order or past the limit marks the upload failed; the write-through that names it then fails and the file in work/
 * stays as it was.
 */
type Upload = { writer: Writer; file: string; handle: FileHandle | undefined; created: boolean; size: number; hash: Hash; failed: string | undefined; chain: Promise<void> };

const VIEW_BUFFER = 4_000;
const SEGMENT = /^[^/\0]+$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Viewers get file contents in their frames; past this they get no files (as before chunked restore). */
const VIEW_FILES_LIMIT = 64 * 1024 * 1024;
/** A restore stops sending while this much is queued on the socket. */
const RESTORE_HIGH_WATER = 4 * CHUNK_BYTES;

/** A checkout the pipe refused: nothing was released, the run is still the tab's. `code`: NOT_WRITER, BUSY, HEAD_MISMATCH. */
export class CheckoutRefused extends Error {
  readonly code: string;
  /** The store's head when the head was what differed. */
  readonly head: number | undefined;
  constructor(code: string, message: string, head?: number) {
    super(message);
    this.name = "CheckoutRefused";
    this.code = code;
    this.head = head;
  }
}

/** The file a checkout leaves next to the run's store (`store/checkout.json`): the head handed over, when, by which tab, and the browser's conversation. The server reads it before it lets anything attach. */
export const CHECKOUT_MARKER = "checkout.json";
/** What the last check-in left beside the store, written before the mark is removed: {sha256 of the store taken, head, files, tab, at}. A browser that never saw the reply sends the same check-in again and is answered from it. */
export const CHECKIN_RECEIPT = "checkin.json";
export type CheckinReceipt = { sha256: string; head: number; files: number; tab: string; at: number };
export type CheckoutMarker = { head: number; at: number; tab: string; conversation?: number };

/** A check-in the pipe refused because the browser's store does not extend the head the server released: nothing was changed. `table` names where the first difference is. */
export class CheckinRefused extends Error {
  readonly code: string;
  readonly table: string | undefined;
  constructor(code: string, message: string, table?: string) {
    super(message);
    this.name = "CheckinRefused";
    this.code = code;
    this.table = table;
  }
}

/**
 * Whether the store attached as `browser` extends the one in `main` (the released store at `head`): why not, or undefined. Append-only tables must keep every released row exactly; tables whose rows
 * advance (tasks, submissions, documents) must keep every released row's identity, and the ones that were final (terminal tasks, done submissions) exactly; every row the browser added is past `head`.
 */
async function extendsReleased(db: SqliteExecutor, head: number): Promise<{ table: string; message: string } | undefined> {
  const none = async (table: string, sql: string, what: string, ...params: SqliteValue[]) => {
    const row = await db.get<{ n: number | bigint }>(sql, ...params);
    return Number(row?.n ?? 0) === 0 ? undefined : { table, message: `${what}: ${Number(row!.n)} row(s) of ${table} differ` };
  };
  const meta = await db.get<{ a: number | bigint; b: number | bigint }>("SELECT (SELECT next_seq FROM main.durable_metadata WHERE singleton = 1) AS a, (SELECT next_seq FROM browser.durable_metadata WHERE singleton = 1) AS b");
  if (meta === undefined || Number(meta.b) < Number(meta.a)) return { table: "durable_metadata", message: `the browser's store is at ${Number(meta?.b ?? 0) - 1}, behind the released head ${head}` };
  const checksSeq: (() => Promise<{ table: string; message: string } | undefined>)[] = [
    () => none("entries", "SELECT count(*) AS n FROM main.entries r WHERE NOT EXISTS (SELECT 1 FROM browser.entries b WHERE b.id = r.id AND b.conversation_id = r.conversation_id AND b.head IS r.head AND b.commit_seq = r.commit_seq AND b.record = r.record)", "a released entry is not in the browser's store as it was"),
    () => none("entries", "SELECT count(*) AS n FROM browser.entries b WHERE b.id NOT IN (SELECT id FROM main.entries) AND b.commit_seq <= ?", "an entry the browser added is not past the released head", head),
    () => none("record_ids", "SELECT count(*) AS n FROM main.record_ids r WHERE NOT EXISTS (SELECT 1 FROM browser.record_ids b WHERE b.id = r.id AND b.record_type = r.record_type)", "a released record id is missing or changed"),
    () => none("conversations", "SELECT count(*) AS n FROM main.conversations r WHERE NOT EXISTS (SELECT 1 FROM browser.conversations b WHERE b.id = r.id AND b.owner_conversation_id IS r.owner_conversation_id AND b.owner_task_id IS r.owner_task_id AND b.record = r.record)", "a released conversation is missing or changed"),
    // pi prunes the revisions of a current-only document when it writes a newer base (or retires it): a released revision may be gone, but only where the browser holds a newer one for the same document
    // (past the released head) or retired the document there; one that is still there is exactly as released.
    () => none("document_revisions", "SELECT count(*) AS n FROM main.document_revisions r JOIN browser.document_revisions b ON b.document_id = r.document_id AND b.seq = r.seq WHERE NOT (b.kind = r.kind AND b.version = r.version AND b.content = r.content)", "a released document revision was rewritten"),
    () =>
      none(
        "document_revisions",
        "SELECT count(*) AS n FROM main.document_revisions r WHERE NOT EXISTS (SELECT 1 FROM browser.document_revisions b WHERE b.document_id = r.document_id AND b.seq = r.seq) AND NOT EXISTS (SELECT 1 FROM browser.document_revisions b WHERE b.document_id = r.document_id AND b.seq > ?) AND NOT EXISTS (SELECT 1 FROM browser.documents d WHERE d.id = r.document_id AND d.retired_at > ?)",
        "a released document revision is gone and nothing newer replaced it",
        head,
        head,
      ),
    () => none("document_revisions", "SELECT count(*) AS n FROM browser.document_revisions b WHERE NOT EXISTS (SELECT 1 FROM main.document_revisions r WHERE r.document_id = b.document_id AND r.seq = b.seq) AND b.seq <= ?", "a document revision the browser added is not past the released head", head),
    () => none("documents", "SELECT count(*) AS n FROM main.documents r WHERE NOT EXISTS (SELECT 1 FROM browser.documents b WHERE b.id = r.id AND b.kind = r.kind AND b.family = r.family AND b.key_value = r.key_value AND b.scope_kind = r.scope_kind AND b.owner_id = r.owner_id AND b.created_at = r.created_at)", "a released document is missing or has another identity"),
    () => none("tasks", "SELECT count(*) AS n FROM main.tasks r WHERE NOT EXISTS (SELECT 1 FROM browser.tasks b WHERE b.id = r.id AND b.conversation_id = r.conversation_id AND b.kind = r.kind AND (r.status <> 'terminal' OR (b.status = 'terminal' AND b.record = r.record)))", "a released task is missing, changed identity, or a finished one changed"),
    () => none("submissions", "SELECT count(*) AS n FROM main.submissions r WHERE NOT EXISTS (SELECT 1 FROM browser.submissions b WHERE b.id = r.id AND b.conversation_id = r.conversation_id AND b.request_id IS r.request_id AND (r.status IN ('queued', 'placed') OR (b.status = r.status AND b.record = r.record)))", "a released submission is missing, changed identity, or a finished one changed"),
  ];
  for (const check of checksSeq) {
    const problem = await check();
    if (problem) return problem;
  }
  return undefined;
}

/** The most a snapshot of the run's store is retried when a commit lands while it is taken. */
const SNAPSHOT_TRIES = 3;

export class RunPipe {
  readonly ref: RunRef;
  readonly lease: RunLease;
  #options: RunPipeOptions;
  #store: ArchilStore | undefined;
  #writer: Writer | undefined;
  #viewers = new Set<PipeSocket>();
  #events: Tagged[] = [];
  #epoch = 0;
  #lost: FencedError | undefined;
  #released = false;
  #goneTimer: NodeJS.Timeout | undefined;
  #goneFired = false;
  #models = new Map<string, AbortController>();
  /** Uploads in progress, by `<epoch>:<id>`. */
  #uploads = new Map<string, Upload>();
  /** Each work/ file's SHA-256 by its path, valid while the file's identity (FileKey) is the one recorded with it. */
  #digests = new Map<string, FileKey & { sha256: string }>();
  /** work/'s directories, by path. With #digests, what the pipe knows work/ holds: set by a whole walk, kept by writes. */
  #dirs = new Set<string>();
  /** Whether #digests and #dirs are all of work/ (a whole walk read every file, and no write since lost track). */
  #known = false;
  /** The one upload whose file is open; a chunk of another closes it first, so uploads never pile up open files. */
  #openUpload: Upload | undefined;
  #scratch = 0;
  #drained: { switchId: string; done: () => void } | undefined;
  /** The writer asked to check the run out: no storage call or write-through of it is accepted from here. */
  #checkingOut = false;
  /** What the leaving writer said it had acknowledged last (its drained frame), for the release's evidence. */
  #acked: string | undefined;

  private constructor(ref: RunRef, lease: RunLease, options: RunPipeOptions) {
    this.ref = ref;
    this.lease = lease;
    this.#options = options;
  }

  /** Claim the run and open its store: lease, store, seal check, live. */
  static async open(options: RunPipeOptions): Promise<RunPipe> {
    let pipe: RunPipe | undefined;
    const lease = await openRunLease(options.ref, {
      mountToken: options.mountToken,
      mountRoot: options.mountRoot,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.lease === undefined ? {} : { lease: options.lease }),
      ...(options.acquire === undefined ? {} : { acquire: options.acquire }),
      ...(options.claimDir === undefined ? {} : { claimDir: options.claimDir }),
      holder: { driver: "pipe", host: hostname() },
      onFenced: (error) => pipe?.lostRun(error),
    });
    pipe = new RunPipe(options.ref, lease, options);
    try {
      pipe.#store = await pipe.#openStore(join(lease.claim.store, "run.sqlite"));
      await lease.checkSeal(pipe.#store);
      await lease.live();
    } catch (error) {
      await lease.abandon(error, async () => {
        await pipe!.#store?.storage.close(ctx).catch(() => undefined);
      });
      throw error;
    }
    pipe.#log("pipe.open", { generation: lease.generation, root: lease.claim.root, head: await storeHead(pipe.#store!).catch(() => null), sealedSeq: lease.sealedSeq });
    pipe.#gcTimer();
    return pipe;
  }

  get generation(): number {
    return this.lease.generation;
  }

  get lost(): FencedError | undefined {
    return this.#lost;
  }

  get released(): boolean {
    return this.#released;
  }


  get writerTab(): string | undefined {
    return this.#writer?.dead ? undefined : this.#writer?.tab;
  }

  /** A writer is attached, alive, restored, and its page says its runtime is up: a line sent to it now reaches a page that can run it. */
  get writerReady(): boolean {
    const writer = this.#writer;
    return writer !== undefined && !writer.dead && !writer.attaching && !writer.restoring && writer.pageReady;
  }

  /** The writer's socket closed and it is not yet declared gone: a refresh in its first moment. */
  get writerLeft(): boolean {
    const writer = this.#writer;
    return writer !== undefined && !writer.dead && writer.detached === true;
  }

  /** The writer's page says its runtime is up. */
  pageReady(socket: PipeSocket): void {
    const writer = this.#writer;
    if (writer && writer.socket === socket && !writer.dead) writer.pageReady = true;
  }

  get epoch(): number {
    return this.#epoch;
  }

  #log(event: string, data: Record<string, unknown> = {}): void {
    this.#options.log?.(event, { run: this.ref.id, ...data });
  }

  #openStore(file: string): Promise<ArchilStore> {
    return openArchilStore(file, "exclusive", { onFenced: (error) => void this.lease.fence(error) });
  }

  // ---- attachments ---------------------------------------------------------------------------------------------------

  /**
   * Make `socket` the writer. With a writer already attached, only `takeover` displaces it (the old one is told it moved
   * and its later frames are refused, after its frames in flight settled); otherwise the socket becomes a viewer.
   * Resolves with what happened.
   */
  async attach(socket: PipeSocket, tab: string, takeover: boolean, extra: { environments: Environment[]; move?: Move; env?: string; placed?: boolean } = { environments: [] }): Promise<"writer" | "viewer"> {
    this.#assertUsable();
    if (this.#checkingOut) throw new PipeLostError("CHECKED_OUT", "the run is being checked out to a browser"); // no attach, not even this tab's own, while the handover is decided
    const current = this.#writer && !this.#writer.dead ? this.#writer : undefined;
    if (current && !takeover && current.tab !== tab) {
      this.addViewer(socket);
      return "viewer";
    }
    if (current) await this.#retire(current, current.tab === tab ? "REATTACHED" : "MOVED", current.tab === tab ? "this tab attached again" : "the run moved to another device");
    this.#viewers.delete(socket);
    const epoch = ++this.#epoch;
    let store = this.#store!;
    if (this.#options.scratchStores) {
      store = await this.#openStore(join(this.lease.claim.root, "tmp", "conformance", `case-${++this.#scratch}.sqlite`));
    } else {
      // Each attachment is a new Session over the run's store, as after a restart: reopen it so no state of the last
      // Session's storage object carries over.
      await this.#store!.storage.close(ctx);
      store = this.#store = await this.#openStore(join(this.lease.claim.store, "run.sqlite"));
    }
    const writer: Writer = { socket, epoch, tab, lastPing: Date.now(), inflight: new Set(), dead: false, closed: false, store, storage: this.lease.observe(store.storage), attachedAt: Date.now(), attaching: true, uploading: 0, restoring: true, pageReady: false };
    this.#writer = writer;
    this.#goneFired = false;
    let manifest: Awaited<ReturnType<RunPipe["manifest"]>>;
    try {
      // Every earlier writer is retired: an upload left in tmp/pipe-uploads/ (this pipe's, or a crashed one's) is stale.
      await this.#discardUploads(() => true);
      await rm(this.#uploadDir, { recursive: true, force: true });
      manifest = await this.manifest();
    } catch (error) {
      // No half-attached writer stays behind: retired, so the gone check and the next hello see no writer.
      writer.attaching = false;
      await this.#retire(writer, "ATTACH_FAILED", `the attach failed: ${(error as Error).message}`);
      throw error;
    }
    socket.send({
      t: "attached",
      epoch,
      generation: this.lease.generation,
      manifest: manifest.entries.filter((e) => !lazyPath(e.path, this.#options.noRestore ?? [])),
      model: this.#options.model.options.model,
      budget: { used: this.#options.model.spent, cap: this.#options.model.options.budgetTokens },
      environments: extra.environments,
      ...(extra.move ? { move: extra.move } : {}),
      ...(extra.placed ? { placed: true } : {}),
      ...(this.#options.noRestore?.length ? { noRestore: [...this.#options.noRestore] } : {}),
      ...(this.#options.app ? { app: this.#options.app } : {}),
    });
    // Its grace starts now: its pings reach the pipe only once the attach is done.
    writer.attaching = false;
    writer.lastPing = Date.now();
    this.#broadcast({ t: "placement", placement: { where: "tab", tab, epoch, generation: this.lease.generation, env: extra.env ?? "tab" } });
    // The digest is for the log only: computed after the attach returns, never on its path.
    void (this.#options.digest ?? manifestDigest)(manifest.entries).then(
      (workDigest) => this.#log("pipe.attach", { tab, epoch, files: manifest.files, bytes: manifest.bytes, workDigest }),
      (error: Error) => this.#log("pipe.attach", { tab, epoch, files: manifest.files, bytes: manifest.bytes, workDigest: `unreadable: ${error.message}` }),
    );
    // The files follow the manifest; a retire waits for the stream, which stops at its next chunk.
    void this.#track(writer, this.#streamRestore(writer, manifest)).catch((error: Error) => {
      this.#log("pipe.restore-failed", { tab, epoch, error: error.message });
      if (writer.dead || this.#goneFired) return;
      // As if the writer left: retired, and the server places the run elsewhere.
      this.#goneFired = true;
      void this.#retire(writer, "RESTORE_FAILED", `the pipe could not send the workspace: ${error.message}`).then(() => this.#options.onWriterGone?.(this));
    });
    return "writer";
  }

  /** The manifest's files, chunk by chunk in its order, then `restore-end`; it waits while the socket is backed up. */
  async #streamRestore(writer: Writer, manifest: Manifest): Promise<void> {
    const socket = writer.socket;
    const stopped = () => writer.dead || socket.isOpen?.() === false;
    const work = this.lease.claim.work;
    // Each file sent must be the file the manifest describes: the same identity when it is opened, the same bytes once
    // read, and the file its path still names after that (a rename can replace a path while its old file is read).
    const still = async (path: string) => {
      const expected = manifest.keys.get(path);
      const now = await lstat(join(work, path), { bigint: true }).then(keyOf, () => null);
      if (!expected || !now || !sameKey(now, expected)) throw this.#changed(path);
    };
    try {
      for (const entry of manifest.entries) {
        if (entry.kind !== "file" || lazyPath(entry.path, this.#options.noRestore ?? [])) continue;
        if (entry.size === 0) {
          await still(entry.path);
          continue;
        }
        const handle = await open(join(work, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const expected = manifest.keys.get(entry.path);
          if (!expected || !sameKey(keyOf(await handle.stat({ bigint: true })), expected)) throw this.#changed(entry.path);
          const hash = createHash("sha256");
          for (let offset = 0; offset < entry.size; ) {
            while (!stopped() && (socket.bufferedAmount?.() ?? 0) > RESTORE_HIGH_WATER) await new Promise((r) => setTimeout(r, 5));
            if (stopped()) return;
            const length = Math.min(CHUNK_BYTES, entry.size - offset);
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            if (bytesRead !== length) throw this.#changed(entry.path);
            hash.update(buffer);
            socket.send({ t: "restore-chunk", path: entry.path, offset, data: buffer.toString("base64") });
            offset += length;
          }
          if (hash.digest("hex") !== entry.sha256) throw this.#changed(entry.path);
        } finally {
          await handle.close();
        }
        await still(entry.path);
      }
      // Just before the end, every file of the manifest is still the file it was (an earlier one may have been replaced
      // while a later one was sent).
      for (const path of manifest.keys.keys()) await still(path);
      if (!stopped()) socket.send({ t: "restore-end", files: manifest.files, bytes: manifest.bytes });
    } finally {
      writer.restoring = false;
    }
  }

  /** The writer's answer to the restore: logged (a writer whose restore failed closes its socket itself). */
  restored(socket: PipeSocket, frame: { ok: true; files: number; bytes: number; ms: number } | { ok: false; error: string }): void {
    const writer = this.#writer;
    if (!writer || writer.socket !== socket || writer.dead) return;
    if (frame.ok) this.#log("pipe.restored", { tab: writer.tab, epoch: writer.epoch, files: frame.files, bytes: frame.bytes, ms: Date.now() - writer.attachedAt, tabMs: frame.ms });
    else this.#log("pipe.restore-refused", { tab: writer.tab, epoch: writer.epoch, error: frame.error });
  }

  addViewer(socket: PipeSocket): void {
    this.#viewers.add(socket);
    // The writer answers with a fresh snapshot of its conversation, so what a viewer replays starts there.
    if (this.#writer && !this.#writer.dead) this.#writer.socket.send({ t: "want-snapshot" });
  }

  removeViewer(socket: PipeSocket): void {
    this.#viewers.delete(socket);
  }

  /** Hand the viewers back to the server (the pipe is ending; they keep watching whoever runs the run next). */
  takeViewers(): PipeSocket[] {
    const viewers = [...this.#viewers];
    this.#viewers.clear();
    return viewers;
  }

  /** The current events every new viewer replays, oldest first. */
  get events(): readonly Tagged[] {
    return this.#events;
  }

  /**
   * A planned move: ask the writer to finish its current step and close its Session, and resolve once it says it did
   * (or after `timeoutMs`). The release that follows retires it either way.
   */
  drainWriter(switchId: string, timeoutMs: number): Promise<boolean> {
    const writer = this.#writer;
    if (!writer || writer.dead) return Promise.resolve(true);
    writer.socket.send({ t: "drain", switchId });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#drained = undefined;
        resolve(false);
      }, timeoutMs);
      this.#drained = { switchId, done: () => (clearTimeout(timer), (this.#drained = undefined), resolve(true)) };
    });
  }

  /** The writer finished draining for `switchId`. */
  drained(socket: PipeSocket, switchId: string, acked?: string): void {
    if (this.#writer?.socket !== socket || this.#drained?.switchId !== switchId) return;
    if (typeof acked === "string") this.#acked = acked;
    this.#drained.done();
  }

  /** Whether `socket` is the attached writer's. */
  isWriter(socket: PipeSocket): boolean {
    return this.#writer !== undefined && !this.#writer.dead && this.#writer.socket === socket;
  }

  /** The socket closed: a writer's departure starts the grace; a viewer just leaves. */
  detach(socket: PipeSocket): void {
    this.#viewers.delete(socket);
    const writer = this.#writer;
    if (writer && writer.socket === socket && !writer.dead) {
      writer.detached = true;
      writer.lastPing = Math.min(writer.lastPing, Date.now() - (this.#options.writerGraceMs ?? 3_000) + 250);
    }
  }

  ping(socket: PipeSocket, at: number): void {
    this.heard(socket);
    socket.send({ t: "pong", at, now: Date.now() });
  }

  /**
   * A frame arrived from `socket`. From the writer, any frame shows it is alive, as a ping does: a ping sent during a
   * long upload waits behind the upload's frames on the same connection.
   */
  heard(socket: PipeSocket): void {
    const writer = this.#writer;
    if (writer && writer.socket === socket && !writer.dead) writer.lastPing = Date.now();
  }

  #gcTimer(): void {
    this.#goneTimer = setInterval(() => {
      const writer = this.#writer;
      if (!writer || writer.dead || writer.attaching || this.#goneFired || this.#lost || this.#released) return;
      // The server stops reading a writer's frames (its pings too) while its upload chunks wait for the disk.
      if (writer.uploading > 0) {
        writer.lastPing = Date.now();
        return;
      }
      if (Date.now() - writer.lastPing > (this.#options.writerGraceMs ?? 3_000)) {
        this.#goneFired = true;
        void this.#retire(writer, "GONE", "no ping from the tab").then(() => {
          this.#log("pipe.writer-gone", { tab: writer.tab, epoch: writer.epoch });
          this.#options.onWriterGone?.(this);
        });
      }
    }, 250);
    this.#goneTimer.unref();
  }

  /** Refuse every later frame of `writer`, wait for the ones it already sent, close its scratch store. */
  async #retire(writer: Writer, code: string, message: string): Promise<void> {
    if (writer.dead) return;
    writer.dead = true;
    try {
      writer.socket.send({ t: "lost", code, message });
      writer.socket.close(4001, code);
    } catch {
      // The socket may already be gone.
    }
    for (const [id, abort] of this.#models) if (id.startsWith(`${writer.epoch}:`)) abort.abort();
    await Promise.allSettled([...writer.inflight]);
    await this.#discardUploads((upload) => upload.writer === writer);
    if (this.#options.scratchStores && !writer.closed) await writer.store.storage.close(ctx).catch(() => undefined);
  }

  #writerFor(socket: PipeSocket): Writer {
    if (this.#lost) throw new PipeLostError("FENCED", `the pipe lost the run: ${this.#lost.message}`);
    if (this.#released) throw new PipeLostError("RELEASED", "the run was released");
    if (this.#checkingOut) throw new PipeLostError("CHECKED_OUT", "the run is being checked out to a browser");
    const writer = this.#writer;
    if (!writer || writer.socket !== socket || writer.dead) throw new PipeLostError("NOT_WRITER", "this socket does not hold the run");
    return writer;
  }

  #track<T>(writer: Writer, work: Promise<T>): Promise<T> {
    writer.inflight.add(work);
    void work.finally(() => writer.inflight.delete(work)).catch(() => undefined);
    return work;
  }

  /** Throws unless `writer` is still the writer. Synchronous: call it in the same turn as the rename it guards. */
  #assertCurrent(writer: Writer): void {
    if (this.#lost) throw new PipeLostError("FENCED", `the pipe lost the run: ${this.#lost.message}`);
    if (this.#released) throw new PipeLostError("RELEASED", "the run was released");
    if (this.#checkingOut) throw new PipeLostError("CHECKED_OUT", "the run is being checked out to a browser");
    if (writer.dead || this.#writer !== writer) throw new PipeLostError("MOVED", "the run moved to another device");
  }

  // ---- storage ---------------------------------------------------------------------------------------------------------

  async rpc(socket: PipeSocket, id: number, method: StorageMethod, args: Tagged[]): Promise<void> {
    let writer: Writer;
    try {
      writer = this.#writerFor(socket);
      if (!STORAGE_METHODS.includes(method)) throw new TypeError(`no storage method ${JSON.stringify(method)}`);
    } catch (error) {
      socket.send({ t: "res", id, ok: false, error: errorToWire(error) });
      return;
    }
    const started = performance.now();
    const work = this.#track(writer, (async () => {
      const storage = writer.storage as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const values = args.map(untag);
      if (writer.closed) throw new Error("Storage is closed");
      if (method === "close") {
        writer.closed = true;
        // A scratch store is the attachment's own; the run's store stays open for the next attachment.
        if (this.#options.scratchStores) await writer.store.storage.close(ctx);
        return undefined;
      }
      if (method === "mintId") return storage.mintId!();
      return storage[method]!.apply(writer.storage, [...values, ctx]);
    })());
    try {
      const result = await work;
      // A commit that resolved after the takeover is still durable, but its writer is told it lost the run.
      if (writer.dead) throw new PipeLostError("MOVED", "the run moved to another device");
      socket.send({ t: "res", id, ok: true, result: tag(result), ms: performance.now() - started });
    } catch (error) {
      if (error instanceof FencedError) this.lostRun(error);
      const lost = this.#lost ? new PipeLostError("FENCED", `the pipe lost the run: ${this.#lost.message}`) : error;
      socket.send({ t: "res", id, ok: false, error: errorToWire(lost) });
    }
  }

  // ---- workspace -------------------------------------------------------------------------------------------------------

  /** Apply the tab's changes under work/, then the barrier; answered only once everything is durable. */
  async files(socket: PipeSocket, id: number, changes: FileChange[]): Promise<void> {
    let writer: Writer;
    try {
      writer = this.#writerFor(socket);
      if (writer.restoring) throw new Error("work/ is still being restored to this writer; write after it is ready");
    } catch (error) {
      socket.send({ t: "res", id, ok: false, error: errorToWire(error) });
      return;
    }
    const started = performance.now();
    const work = this.#track(writer, (async () => {
      for (const change of changes) await this.#apply(writer, change);
      await this.lease.barrier();
    })());
    try {
      await work;
      if (writer.dead) throw new PipeLostError("MOVED", "the run moved to another device");
      socket.send({ t: "res", id, ok: true, result: tag({ applied: changes.length }), ms: performance.now() - started });
      if (changes.length > 0) this.#broadcastFiles();
    } catch (error) {
      if (error instanceof FencedError) this.lostRun(error);
      const lost = this.#lost ? new PipeLostError("FENCED", `the pipe lost the run: ${this.#lost.message}`) : error;
      socket.send({ t: "res", id, ok: false, error: errorToWire(lost) });
    }
  }

  /** A file under work/ as the mount has it; undefined when there is none there (a directory or a link is not a file). */
  async readWork(path: string): Promise<Uint8Array | undefined> {
    this.#assertUsable();
    if (this.#releasing) throw new Error("the run is being released: read it from the disk");
    return this.#reading(this.#readWork(path));
  }

  async #readWork(path: string): Promise<Uint8Array | undefined> {
    const parts = RunPipe.segments(path);
    let at = this.lease.claim.work;
    for (const [i, part] of parts.entries()) {
      at = join(at, part);
      const info = await lstat(at).catch(() => null);
      if (!info || info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return undefined;
    }
    return new Uint8Array(await readFile(at));
  }

  /**
   * Write files under work/ on behalf of the attached writer `tab`, from outside its socket (the server's HTTP route for
   * that tab's page): the checks, the barrier before the answer, and the viewers' update are those of the socket's.
   */
  async writeAsWriter(tab: string, changes: FileChange[]): Promise<{ ms: number }> {
    this.#assertUsable();
    const writer = this.#writer;
    if (!writer || writer.dead || writer.tab !== tab) throw new PipeLostError("NOT_WRITER", "this tab does not hold the run");
    if (writer.restoring) throw new Error("work/ is still being restored to this tab; write after it is ready");
    for (const change of changes) RunPipe.segments(change.path);
    const started = performance.now();
    try {
      await this.#track(writer, (async () => {
        for (const change of changes) await this.#apply(writer, change);
        await this.lease.barrier();
      })());
    } catch (error) {
      if (error instanceof FencedError) this.lostRun(error);
      throw error;
    }
    if (writer.dead) throw new PipeLostError("MOVED", "the run moved to another device");
    if (changes.length > 0) this.#broadcastFiles();
    return { ms: performance.now() - started };
  }

  /** Segments of a workspace path: relative, no empty, `.` or `..` component, no NUL. */
  static segments(path: string): string[] {
    if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.startsWith("/")) throw new Error(`workspace path ${JSON.stringify(path)} is not relative`);
    const parts = path.split("/");
    for (const part of parts) if (!SEGMENT.test(part) || part === "." || part === "..") throw new Error(`workspace path ${JSON.stringify(path)} has an unsafe component`);
    return parts;
  }

  /** Directories along `parts` under work/, made where missing; a component that is not a real directory is refused. */
  async #dirAt(parts: string[]): Promise<string> {
    let dir = this.lease.claim.work;
    for (const [i, part] of parts.entries()) {
      dir = join(dir, part);
      const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
      if (info === null) await mkdir(dir).catch((error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? undefined : Promise.reject(error)));
      else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${parts.join("/")} crosses ${part}, which is not a directory`);
      this.#dirs.add(parts.slice(0, i + 1).join("/"));
    }
    return dir;
  }

  async #apply(writer: Writer, change: FileChange): Promise<void> {
    const parts = RunPipe.segments(change.path);
    const name = parts.at(-1)!;
    // Every step that changes work/ first checks, in its own turn, that the writer is still the writer: a write-through
    // in flight when its writer is retired stops at its next step and changes nothing after that.
    const live = () => this.#assertCurrent(writer);
    if (change.op === "mkdir") {
      live();
      await this.#dirAt(parts);
      return;
    }
    if (change.op === "write" && "upload" in change) {
      await this.#applyUpload(writer, change, parts);
      return;
    }
    live();
    const dir = await this.#dirAt(parts.slice(0, -1));
    const target = join(dir, name);
    if (change.op === "delete") {
      const info = await lstat(target).catch(() => null);
      if (info === null) return;
      live();
      // Dropping a digest is always safe (the next manifest reads the file); keeping a wrong one never is. A removal that
      // fails part way leaves files the pipe no longer tracks: it stops trusting what it knows until a walk.
      this.#forget(change.path);
      try {
        if (info.isDirectory()) await rm(target, { recursive: true, force: true });
        else await unlink(target);
      } catch (error) {
        this.#known = false;
        throw error;
      }
      return;
    }
    // Written beside the target and renamed over it: a reader never sees half a file, and a symbolic link at the target
    // is replaced, never followed.
    const temp = join(dir, `.pipe-${randomBytes(6).toString("hex")}`);
    const bytes = fromBase64(change.data);
    live();
    await writeFile(temp, bytes, { mode: (change.mode ?? 0o644) & 0o777 });
    await this.#replace(writer, temp, target, change.path, createHash("sha256").update(bytes).digest("hex"));
  }

  /**
   * Put `temp` at `target` (work/'s `path`) if `writer` is still the writer, else remove `temp` and throw. A directory at
   * the target is removed first, after the same check. The final check and the rename run in one turn (a synchronous
   * rename), so a writer retired while its write-through was in flight lands nothing. Once it landed, `sha256` (the
   * content's, known to the caller) is recorded for the file's new identity.
   */
  async #replace(writer: Writer, temp: string, target: string, path: string, sha256: string): Promise<void> {
    let forgot = false;
    let ino: bigint;
    try {
      // The inode `sha256` belongs to: a rename keeps it, so after the rename the record goes to that file only.
      ino = (await lstat(temp, { bigint: true })).ino;
      const existing = await lstat(target).catch(() => null);
      if (existing?.isDirectory()) {
        this.#assertCurrent(writer);
        this.#forget(path);
        forgot = true;
        await rm(target, { recursive: true, force: true });
      }
      this.#assertCurrent(writer);
      this.#forget(path);
      forgot = true;
      renameSync(temp, target);
    } catch (error) {
      // Forgotten entries whose files may remain: what the pipe knows is no longer all of work/.
      if (forgot) this.#known = false;
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    await this.#remember(path, target, sha256, ino);
  }

  /** Where uploads land: inside the claim, outside work/, on the same filesystem as work/ (a rename moves them). */
  get #uploadDir(): string {
    return join(this.lease.claim.root, "tmp", "pipe-uploads");
  }

  /**
   * One chunk of an upload (`upload` frame). No answer: a refused or failed chunk fails the upload, and the
   * write-through that names it reports why. Chunks of one upload are written in order, each after the one before;
   * each written chunk shows the writer is alive. A writer's unfinished uploads are bounded in number and in bytes, and
   * only one upload's file is open at a time.
   */
  upload(socket: PipeSocket, id: string, offset: number, data: string): Promise<void> {
    let writer: Writer;
    try {
      writer = this.#writerFor(socket);
    } catch {
      return Promise.resolve();
    }
    if (typeof id !== "string" || !UPLOAD_ID.test(id)) return Promise.resolve();
    const key = `${writer.epoch}:${id}`;
    let upload = this.#uploads.get(key);
    if (!upload) {
      // Past the cap there is no record: the write-through that names it fails ("no upload").
      const unfinished = [...this.#uploads.values()].filter((u) => u.writer === writer).length;
      if (unfinished >= (this.#options.maxUnfinishedUploads ?? 1024)) {
        this.#log("pipe.upload-refused", { tab: writer.tab, reason: `${unfinished} unfinished uploads` });
        return Promise.resolve();
      }
      upload = { writer, file: join(this.#uploadDir, `${writer.epoch}-${id}`), handle: undefined, created: false, size: 0, hash: createHash("sha256"), failed: undefined, chain: Promise.resolve() };
      this.#uploads.set(key, upload);
    }
    const u = upload;
    const limit = this.#options.uploadLimitBytes ?? 4 * 1024 ** 3;
    u.chain = this.#track(writer, u.chain.then(async () => {
      if (u.failed) return;
      writer.uploading++;
      try {
        if (offset !== u.size) throw new Error(`a chunk at byte ${offset}, expected ${u.size}`);
        const bytes = Buffer.from(String(data), "base64");
        if (bytes.length > CHUNK_BYTES) throw new Error(`a chunk of ${bytes.length} bytes, over ${CHUNK_BYTES}`);
        let held = bytes.length;
        for (const other of this.#uploads.values()) if (other.writer === writer) held += other.size;
        if (held > limit) throw new Error(`this writer's unfinished uploads would hold ${held} bytes, over ${limit}`);
        if (this.#openUpload !== u) {
          await this.#closeUpload(this.#openUpload);
          this.#openUpload = u;
        }
        if (!u.handle) {
          await mkdir(this.#uploadDir, { recursive: true });
          u.handle = await open(u.file, u.created ? "r+" : "wx", 0o600);
          u.created = true;
        }
        // A write may take fewer bytes than asked: write the rest before the chunk counts.
        for (let done = 0; done < bytes.length; ) {
          const { bytesWritten } = await u.handle.write(bytes, done, bytes.length - done, offset + done);
          if (bytesWritten <= 0) throw new Error(`the disk took no bytes at ${offset + done}`);
          done += bytesWritten;
        }
        u.hash.update(bytes);
        u.size += bytes.length;
      } catch (error) {
        u.failed = (error as Error).message;
      } finally {
        writer.uploading--;
        this.heard(writer.socket);
      }
    }));
    return u.chain;
  }

  /** Close `upload`'s file if it is open (its next chunk reopens it). */
  async #closeUpload(upload: Upload | undefined): Promise<void> {
    if (!upload) return;
    if (this.#openUpload === upload) this.#openUpload = undefined;
    const handle = upload.handle;
    upload.handle = undefined;
    await handle?.close().catch(() => undefined);
  }

  /** A write whose content is an upload: checked against the change's size and SHA-256, then renamed into place. */
  async #applyUpload(writer: Writer, change: Extract<FileChange, { upload: unknown }>, parts: string[]): Promise<void> {
    const key = `${writer.epoch}:${change.upload.id}`;
    const upload = this.#uploads.get(key);
    if (!upload) throw new Error(`${change.path}: no upload ${JSON.stringify(change.upload.id)} from this writer`);
    this.#uploads.delete(key);
    try {
      await upload.chain;
      await this.#closeUpload(upload);
      if (upload.failed) throw new Error(`${change.path}: the upload failed: ${upload.failed}`);
      // An empty upload never created its file.
      if (!upload.created) await writeFile(upload.file, new Uint8Array(0), { flag: "wx", mode: 0o600 });
      const sha256 = upload.hash.digest("hex");
      if (upload.size !== change.upload.size || sha256 !== change.upload.sha256) {
        throw new Error(`${change.path}: the upload has ${upload.size} bytes with SHA-256 ${sha256}, not ${change.upload.size} bytes with ${change.upload.sha256}`);
      }
      await chmod(upload.file, (change.mode ?? 0o644) & 0o777);
      this.#assertCurrent(writer);
      const dir = await this.#dirAt(parts.slice(0, -1));
      await this.#replace(writer, upload.file, join(dir, parts.at(-1)!), change.path, sha256);
    } catch (error) {
      await this.#closeUpload(upload);
      await unlink(upload.file).catch(() => undefined);
      throw error;
    }
  }

  /** Remove the uploads `which` selects: their chunks settle first, then the file goes. */
  async #discardUploads(which: (upload: Upload) => boolean): Promise<void> {
    for (const [key, upload] of [...this.#uploads]) {
      if (!which(upload)) continue;
      this.#uploads.delete(key);
      await upload.chain.catch(() => undefined);
      await this.#closeUpload(upload);
      await unlink(upload.file).catch(() => undefined);
    }
  }

  /**
   * work/ as the disk has it, without content: every file's size and SHA-256, every directory, symbolic links as their
   * target text. Uploads and `.pipe-` temporaries are not part of it.
   */
  async manifest(): Promise<Manifest> {
    const limit = this.#options.restoreLimitBytes ?? 1024 ** 3;
    const entries: ManifestEntry[] = [];
    const keys = new Map<string, FileKey>();
    let files = 0;
    let bytes = 0;
    let stable = true;
    await this.#walkWork(async (path, full, info) => {
      if (info.isSymbolicLink()) entries.push({ path, kind: "symlink", target: await readlink(full) });
      else if (info.isDirectory()) entries.push({ path, kind: "directory" });
      else {
        // Refused before it is read: a file past the limit is never hashed only to be refused.
        const lazy = lazyPath(path, this.#options.noRestore ?? []);
        if (!lazy && bytes + info.size > limit) throw new Error(`the workspace is larger than ${limit} bytes`);
        const { sha256, key, recorded } = await this.#fileDigest(path, full);
        stable &&= recorded;
        const size = Number(key.size);
        // files and bytes are what an attach restores: lazy prefixes are left out of both.
        if (!lazy) bytes += size;
        if (bytes > limit) throw new Error(`the workspace is larger than ${limit} bytes`);
        if (!lazy) files++;
        keys.set(path, key);
        entries.push({ path, kind: "file", size, sha256, mode: info.mode & 0o777, mtimeMs: info.mtimeMs });
      }
    });
    // The walk is what work/ holds: what the pipe kept should say the same (logged if not), and is replaced by it.
    const kept = this.#knownEntries();
    if (kept) {
      const [was, is] = await Promise.all([manifestDigest(kept), manifestDigest(entries)]);
      if (was !== is) this.#log("pipe.work-diverged", { kept: was, walked: is });
    }
    for (const path of [...this.#digests.keys()]) if (!keys.has(path)) this.#digests.delete(path);
    this.#dirs = new Set(entries.filter((e) => e.kind === "directory").map((e) => e.path));
    this.#known = stable;
    return { entries, keys, files, bytes };
  }

  /** What the pipe knows work/ holds, as manifest entries (only path, kind and digest mean anything), or null. */
  #knownEntries(): ManifestEntry[] | null {
    if (!this.#known) return null;
    // The walk's rule for the pipe's own names: none at the top of work/, no file below.
    const walked = (path: string, kind: "file" | "directory") => !path.split("/")[0]!.startsWith(".pipe-") && !(kind === "file" && path.split("/").at(-1)!.startsWith(".pipe-"));
    const entries: ManifestEntry[] = [...this.#dirs].filter((path) => walked(path, "directory")).map((path) => ({ path, kind: "directory" as const }));
    for (const [path, d] of this.#digests) if (walked(path, "file")) entries.push({ path, kind: "file", size: Number(d.size), sha256: d.sha256, mode: 0, mtimeMs: 0 });
    return entries;
  }

  /**
   * A work/ file's SHA-256 and the identity it belongs to: from the cache when the file's identity is the one recorded,
   * else read once and recorded only if the file did not change while it was read.
   */
  async #fileDigest(path: string, full: string): Promise<{ sha256: string; key: FileKey; recorded: boolean }> {
    const now = keyOf(await lstat(full, { bigint: true }));
    const cached = this.#digests.get(path);
    if (cached && sameKey(cached, now)) return { sha256: cached.sha256, key: now, recorded: true };
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = keyOf(await handle.stat({ bigint: true }));
      const sha256 = await hashHandle(handle);
      const after = keyOf(await handle.stat({ bigint: true }));
      const recorded = sameKey(before, after);
      if (recorded) this.#digests.set(path, { ...after, sha256 });
      else this.#digests.delete(path);
      return { sha256, key: before, recorded };
    } finally {
      await handle.close();
    }
  }

  /**
   * Record what a write-through just put at `path`: its digest under the identity the file has now, if the path still
   * names the inode the write renamed into place. Another write may have replaced it since (writes over HTTP run beside
   * the socket's): that write's record stands, and if it has none, the pipe stops trusting what it knows until a walk.
   */
  async #remember(path: string, full: string, sha256: string, ino: bigint): Promise<void> {
    try {
      const now = await lstat(full, { bigint: true });
      if (now.ino !== ino) {
        if (!this.#digests.has(path)) this.#known = false;
        return;
      }
      this.#digests.set(path, { ...keyOf(now), sha256 });
    } catch {
      this.#digests.delete(path);
      this.#known = false;
    }
  }

  /** Drop what the pipe knows of `path` and of everything under it (a file or a directory that went). */
  #forget(path: string): void {
    for (const key of [...this.#digests.keys()]) if (key === path || key.startsWith(`${path}/`)) this.#digests.delete(key);
    for (const dir of [...this.#dirs]) if (dir === path || dir.startsWith(`${path}/`)) this.#dirs.delete(dir);
  }

  /** A file that changed during an attach: its digest is dropped (the next attach reads it), the restore fails. */
  #changed(path: string): Error {
    this.#digests.delete(path);
    this.#known = false;
    return new Error(`${path} changed during the attach; attach again`);
  }

  /** work/ for viewers, with every file's content (as before chunked restore): nothing past VIEW_FILES_LIMIT. */
  async viewerFiles(): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    let bytes = 0;
    const lazy = this.#options.noRestore ?? [];
    await this.#reading(this.#walkWork(async (path, full, info) => {
      // A lazy prefix is a large result a reader fetches by path: a viewer is not sent it with every change (and a release does not wait on it).
      if (lazyPath(path, lazy)) return;
      if (info.isSymbolicLink()) out.push({ path, kind: "symlink", target: await readlink(full) });
      else if (info.isDirectory()) out.push({ path, kind: "directory" });
      else {
        bytes += info.size;
        if (bytes > VIEW_FILES_LIMIT) throw new Error(`the workspace is larger than ${VIEW_FILES_LIMIT} bytes`);
        out.push({ path, kind: "file", data: toBase64(await readFile(full)), mode: info.mode & 0o777, mtimeMs: info.mtimeMs });
      }
    }));
    return out;
  }

  /**
   * Every entry of work/ in sorted order, parents first; a directory is walked after its own entry. The pipe's own
   * `.pipe-` temporaries are skipped: files anywhere, directories at the top.
   */
  async #walkWork(visit: (path: string, full: string, info: Stats) => Promise<void>): Promise<void> {
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const name of (await readdir(dir)).sort()) {
        const path = prefix === "" ? name : `${prefix}/${name}`;
        const full = join(dir, name);
        const info = await lstat(full);
        if (name.startsWith(".pipe-") && (prefix === "" || info.isFile())) continue;
        if (!info.isSymbolicLink() && !info.isDirectory() && !info.isFile()) continue;
        await visit(path, full, info);
        if (info.isDirectory()) await walk(full, path);
      }
    };
    await walk(this.lease.claim.work, "");
  }

  async #broadcastFiles(): Promise<void> {
    if (this.#viewers.size === 0 || this.#releasing) return;
    try {
      const files = await this.viewerFiles();
      this.#broadcast({ t: "files-changed", files }, false);
    } catch (error) {
      this.#log("pipe.files-broadcast-failed", { error: (error as Error).message });
    }
  }

  // ---- model -----------------------------------------------------------------------------------------------------------

  async model(socket: PipeSocket, id: number, path: string, body: Tagged, headers?: Record<string, string>): Promise<void> {
    let writer: Writer;
    try {
      writer = this.#writerFor(socket);
    } catch (error) {
      socket.send({ t: "model-end", id, status: 409, error: (error as Error).message });
      return;
    }
    const key = `${writer.epoch}:${id}`;
    const abort = new AbortController();
    this.#models.set(key, abort);
    const work = this.#track(
      writer,
      this.#options.model.forward(path, untag(body) as Record<string, unknown>, {
        head: (status) => socket.send({ t: "model-head", id, status }),
        chunk: (data) => {
          if (!writer.dead) socket.send({ t: "model-chunk", id, data });
        },
        end: (status, error) => socket.send({ t: "model-end", id, status, ...(error ? { error } : {}) }),
      }, abort.signal, headers),
    );
    try {
      await work;
    } finally {
      this.#models.delete(key);
    }
  }

  modelAbort(socket: PipeSocket, id: number): void {
    const writer = this.#writer;
    if (writer && writer.socket === socket) this.#models.get(`${writer.epoch}:${id}`)?.abort();
  }

  // ---- views -----------------------------------------------------------------------------------------------------------

  /** A view event from the writer (what its page shows), kept for late viewers and sent to every viewer. */
  view(socket: PipeSocket, event: Tagged): void {
    const writer = this.#writer;
    if (!writer || writer.socket !== socket || writer.dead) return;
    const kind = (untag(event) as { kind?: unknown } | null)?.kind;
    if (kind === "snapshot") this.#events = [event];
    else this.#events.push(event);
    if (this.#events.length > VIEW_BUFFER) this.#events.splice(0, this.#events.length - VIEW_BUFFER);
    this.#broadcast({ t: "event", event }, false);
  }

  #broadcast(frame: PipeFrame, includeWriter = false): void {
    for (const viewer of this.#viewers) {
      try {
        viewer.send(frame);
      } catch {
        this.#viewers.delete(viewer);
      }
    }
    if (includeWriter && this.#writer && !this.#writer.dead) this.#writer.socket.send(frame);
  }

  broadcast(frame: PipeFrame): void {
    this.#broadcast(frame, true);
  }

  // ---- end of the pipe -------------------------------------------------------------------------------------------------

  /** The claim is lost: tell every socket, refuse everything. The lease already killed nothing (the pipe runs no commands). */
  lostRun(error: FencedError): void {
    if (this.#lost) return;
    this.#lost = error;
    clearInterval(this.#goneTimer);
    this.#log("pipe.fenced", { error: error.message, code: error.code });
    const frame: PipeFrame = { t: "lost", code: "FENCED", message: `the run's claim was taken: ${error.message}` };
    // An upload in progress never lands: every rename checks the pipe is not lost.
    void this.#discardUploads(() => true);
    if (this.#writer && !this.#writer.dead) {
      this.#writer.dead = true;
      try {
        this.#writer.socket.send(frame);
        this.#writer.socket.close(4002, "FENCED");
      } catch {
        // gone
      }
    }
    this.#broadcast({ t: "placement", placement: { where: "parked", detail: "the claim was taken by another host" } });
    this.#options.onLost?.(this, error);
  }

  /**
   * Release the run cleanly: retire the writer, close the store, then the lease (barrier, seal run.json with the
   * store's last sequence, owner lock, unmount). Viewers stay connected to the server.
   */
  /**
   * The release's evidence: the generation released, what the pipe knows work/ held (its entries and digest, hashed
   * after the release), and the leaving writer's acknowledged digest when it drained.
   */
  #releaseEvidence: { generation: number; entries: ManifestEntry[] | null; digest: Promise<string>; acked?: string } | undefined;

  get releaseEvidence() {
    return this.#releaseEvidence;
  }

  async release(why: { code: string; message: string } = { code: "RELEASED", message: "the run was released" }): Promise<void> {
    if (this.#released) return;
    if (this.#lost) throw this.#lost;
    clearInterval(this.#goneTimer);
    // No new read of work/ from here; the ones in flight finish first (an open file keeps the mount busy: the unmount would fail).
    this.#releasing = true;
    await Promise.race([Promise.allSettled([...this.#reads]), new Promise((r) => setTimeout(r, 15_000).unref())]);
    if (this.#writer) await this.#retire(this.#writer, why.code, why.message);
    for (const abort of this.#models.values()) abort.abort();
    await this.#store?.storage.close(ctx);
    this.#released = true;
    // No upload outlives the pipe: the next holder of the claim (a cloud host's agent) never sees one.
    await this.#discardUploads(() => true);
    await rm(this.#uploadDir, { recursive: true, force: true }).catch(() => undefined);
    // The digest of work/ for the log line is what the pipe knows work/ holds, taken now while the claim is held: no
    // read on the handover path. Only when it does not know (no whole walk since it opened) does it walk work/ first.
    const kept = this.#knownEntries();
    const workSource = kept ? "kept" : "walked";
    const entries = kept ?? (await this.manifest().then((m) => m.entries, () => null));
    const started = performance.now();
    await this.lease.release();
    const ms = Math.round(performance.now() - started);
    const generation = this.lease.generation;
    // Hashed and logged after the release: the next host does not wait for it.
    const digest = entries ? (this.#options.digest ?? manifestDigest)(entries) : Promise.reject(new Error("work/ could not be read"));
    this.#releaseEvidence = { generation, entries, digest, ...(this.#acked ? { acked: this.#acked } : {}) };
    void digest.then(
      (workDigest) => this.#log("pipe.released", { ms, workDigest, workSource, generation }),
      (error: Error) => this.#log("pipe.released", { ms, workDigest: `unreadable: ${error.message}`, workSource, generation }),
    );
  }

  /**
   * A consistent copy of the run's store while the writer keeps it: SQLite's VACUUM INTO on the pipe's own connection, into the run's own tmp/ (removed
   * before this returns), with the head of the store it holds. A commit that lands while the copy is taken makes the head differ across it: the copy is taken again.
   */
  async snapshotStore(): Promise<{ bytes: Uint8Array; head: number }> {
    const store = this.#store;
    if (!store || this.#lost || this.#released || this.#releasing || this.#checkingOut) throw new PipeLostError("NO_STORE", "the pipe does not hold the run's store now");
    const dir = join(this.lease.claim.root, "tmp");
    await mkdir(dir, { recursive: true });
    for (let attempt = 0; attempt < SNAPSHOT_TRIES; attempt++) {
      const file = join(dir, `snapshot-${randomBytes(6).toString("hex")}.sqlite`);
      try {
        const before = await storeHead(store);
        await store.database.run("VACUUM INTO ?", file);
        if ((await storeHead(store)) !== before) continue;
        return { bytes: new Uint8Array(await readFile(file)), head: before };
      } finally {
        await rm(file, { force: true }).catch(() => undefined);
      }
    }
    throw new Error(`the run's store changed under ${SNAPSHOT_TRIES} snapshots in a row`);
  }

  /**
   * Hand the run to the writer tab `tab`, for good: the tab holds a copy of the store whose head is `head`. From the moment this starts the writer's storage
   * calls and write-throughs are refused (the calls already in flight settle first); then the copy's head must be the store's head, or nothing is released and
   * the run stays the tab's (CheckoutRefused HEAD_MISMATCH: copy again). Otherwise the claim is released as for a move. Resolves with the head released.
   */
  async checkout(tab: string, head: number, conversation?: number): Promise<number> {
    const writer = this.#writer;
    if (!writer || writer.dead || writer.tab !== tab) throw new CheckoutRefused("NOT_WRITER", "only the tab that runs the run may check it out");
    if (this.#lost || this.#released || this.#releasing || this.#checkingOut || !this.#store) throw new CheckoutRefused("BUSY", "the run is being released or already being checked out");
    this.#checkingOut = true;
    const marker = join(this.lease.claim.store, CHECKOUT_MARKER);
    let current: number;
    try {
      await Promise.allSettled([...writer.inflight]);
      current = await storeHead(this.#store);
      if (current !== head) throw new CheckoutRefused("HEAD_MISMATCH", `the copy's head is ${head} but the store's is ${current}: copy it again`, current);
      // The mark goes onto the disk, beside the store, BEFORE the claim is released: a server that restarts (or another one) finds the run checked out and attaches nothing.
      // It is the whole no-fork guarantee: its bytes are on the disk (fsync the file), then it has its name (rename), then the name is on the disk (fsync the directory).
      const body: CheckoutMarker = { head: current, at: Date.now(), tab, ...(conversation === undefined ? {} : { conversation }) };
      const file = await open(`${marker}.tmp`, "w");
      try {
        await file.writeFile(JSON.stringify(body));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(`${marker}.tmp`, marker);
      const dir = await open(this.lease.claim.store, "r");
      try {
        await dir.sync();
      } catch (error) {
        // A file system that cannot sync a directory says so with EINVAL or ENOTSUP; any other failure means the name may not be durable, and the checkout must not go on.
        if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      } finally {
        await dir.close();
      }
    } catch (error) {
      // Nothing was released: the run is still the tab's, its calls are accepted again, and a retry finds no half-written mark.
      this.#checkingOut = false;
      await rm(`${marker}.tmp`, { force: true }).catch(() => undefined);
      await rm(marker, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await this.release({ code: "CHECKED_OUT", message: "the run was checked out to a browser" });
    } catch (error) {
      // The release began (the writer is retired, the store closed): the pipe cannot go on. The claim was not handed over, so the run is not checked out.
      await rm(marker, { force: true }).catch(() => undefined);
      throw error;
    }
    this.#log("pipe.checked-out", { tab, head: current });
    return current;
  }

  /**
   * Take the browser's copy of the run back, for good (the other half of a checkout). The pipe holds the claim and no writer is attached. In order:
   *   1. the browser's store (`storeBytes`, a whole SQLite file) must EXTEND the store this pipe released at `marker.head` (or the one a failed earlier check-in of the same browser left, which extends it): every row the released store has is in it, the same (the entries,
   *      their ids and commit sequences, the document revisions, the terminal tasks and done submissions byte for byte; the rest by identity), and every new row is past the released head.
   *      Anything else is CHECKIN_DIVERGED and nothing at all has changed (it is checked on a copy, attached to this pipe's own connection);
   *   2. the store is put in place of the run's own (written beside it, fsynced, renamed, the directory fsynced) and reopened at the browser's head;
   *   3. `changes` (the files the browser wrote while it held the run) are applied to work/ with the barrier, as a write-through would;
   *   4. `beforeMarkerRemoval` (a test seam), then the mark is removed LAST, fsynced like it was written.
   * A failure anywhere after 1 leaves the mark: the run is still checked out, no fork is possible, and the same check-in can be sent again (it extends the same prefix).
   */
  async checkIn(o: { tab: string; marker: CheckoutMarker; storeBytes: Uint8Array; changes: FileChange[]; beforeMarkerRemoval?: () => Promise<void> }): Promise<{ head: number; files: number }> {
    this.#assertUsable();
    if (this.#writer && !this.#writer.dead) throw new CheckinRefused("CHECKIN_BUSY", "a writer is attached: the run is not checked out here");
    const store = this.#store;
    if (!store || this.#checkingOut || this.#releasing) throw new CheckinRefused("CHECKIN_BUSY", "the pipe cannot take a check-in now");
    for (const change of o.changes) RunPipe.segments(change.path);
    const tmp = join(this.lease.claim.root, "tmp");
    await mkdir(tmp, { recursive: true });
    const incoming = join(tmp, `checkin-${randomBytes(6).toString("hex")}.sqlite`);
    try {
      const file = await open(incoming, "w");
      try {
        await file.writeFile(o.storeBytes);
        await file.sync();
      } finally {
        await file.close();
      }
      // 1. the prefix check, on a copy attached to this pipe's own connection (main = what was released)
      const released = await storeHead(store);
      // The store on the disk is the one the checkout released, or (after a check-in that failed past this point) the browser's own, which extends it: either way it is the reference.
      if (released < o.marker.head) throw new CheckinRefused("CHECKIN_DIVERGED", `the store on the disk is at ${released}, behind the head the checkout released (${o.marker.head})`, "durable_metadata");
      await store.database.run("ATTACH DATABASE ? AS browser", incoming);
      let browserHead: number;
      try {
        const problem = await extendsReleased(store.database, released);
        if (problem) throw new CheckinRefused("CHECKIN_DIVERGED", problem.message, problem.table);
        browserHead = Number((await store.database.get<{ n: number | bigint }>("SELECT next_seq - 1 AS n FROM browser.durable_metadata WHERE singleton = 1"))!.n);
      } finally {
        await store.database.exec("DETACH DATABASE browser").catch(() => undefined);
      }
      // 2. the swap
      const target = join(this.lease.claim.store, "run.sqlite");
      await this.#store!.storage.close(ctx);
      await rm(`${target}-wal`, { force: true });
      await rm(`${target}-shm`, { force: true });
      await rename(incoming, target);
      const dir = await open(this.lease.claim.store, "r");
      try {
        await dir.sync();
      } catch (error) {
        if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      } finally {
        await dir.close();
      }
      this.#store = await this.#openStore(target);
      if ((await storeHead(this.#store)) !== browserHead) throw new Error("the store put in place is not at the head that was checked");
      // 3. the files, through the same steps as a write-through, under a writer of this check-in's own (there is no socket)
      const stub: PipeSocket = { id: "checkin", send: () => undefined, close: () => undefined, isOpen: () => true };
      const writer: Writer = { socket: stub, epoch: -1, tab: o.tab, lastPing: Date.now(), inflight: new Set(), dead: false, closed: false, store: this.#store, storage: this.lease.observe(this.#store.storage), attachedAt: Date.now(), attaching: false, uploading: 0, restoring: false, pageReady: true };
      this.#writer = writer;
      try {
        for (const change of o.changes) await this.#apply(writer, change);
        await this.lease.barrier();
      } finally {
        this.#writer = undefined;
      }
      // 4. the receipt, then the mark, last
      const receipt: CheckinReceipt = { sha256: createHash("sha256").update(o.storeBytes).digest("hex"), head: browserHead, files: o.changes.length, tab: o.tab, at: Date.now() };
      const receiptFile = join(this.lease.claim.store, CHECKIN_RECEIPT);
      const out = await open(`${receiptFile}.tmp`, "w");
      try {
        await out.writeFile(JSON.stringify(receipt));
        await out.sync();
      } finally {
        await out.close();
      }
      await rename(`${receiptFile}.tmp`, receiptFile);
      await o.beforeMarkerRemoval?.();
      const marker = join(this.lease.claim.store, CHECKOUT_MARKER);
      await rm(marker, { force: true });
      const sync = await open(this.lease.claim.store, "r");
      try {
        await sync.sync();
      } catch (error) {
        if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      } finally {
        await sync.close();
      }
      this.#log("pipe.checked-in", { tab: o.tab, head: browserHead, files: o.changes.length });
      return { head: browserHead, files: o.changes.length };
    } finally {
      await rm(incoming, { force: true }).catch(() => undefined);
    }
  }

  #releasing = false;
  /** The release has begun: work/ is no longer read through this pipe (the disk serves it). */
  get releasing(): boolean {
    return this.#releasing;
  }
  #reads = new Set<Promise<unknown>>();
  #reading<T>(p: Promise<T>): Promise<T> {
    this.#reads.add(p);
    const done = () => void this.#reads.delete(p);
    p.then(done, done);
    return p;
  }

  /** `workspaceDigest` of work/ as the disk has it (from the digests the pipe keeps; a file read only if it changed). */
  async workDigest(): Promise<string> {
    return manifestDigest((await this.manifest()).entries);
  }

  #assertUsable(): void {
    if (this.#lost) throw new PipeLostError("FENCED", `the pipe lost the run: ${this.#lost.message}`);
    if (this.#released) throw new PipeLostError("RELEASED", "the run was released");
  }
}

/** A manifest, and the identity of each of its files when it was made (the stream checks it again). */
type Manifest = { entries: ManifestEntry[]; keys: Map<string, FileKey>; files: number; bytes: number };

/**
 * What identifies a file's content without reading it. A write-through renames a new inode into place; an in-place
 * write moves mtime and ctime. On the Archil mount they move at ns resolution (measured: 50 of 50 same-size rewrites
 * under 1 ms apart moved both); a filesystem with coarse times (ext4 ticks of a few ms) can leave a rewrite within the
 * same tick unseen. Nothing but the write-through writes work/ while the pipe holds the claim; and whatever the key
 * says, the restore hashes what it sends and fails on a mismatch, so a missed rewrite costs a failed attach, never a
 * stale file.
 */
type FileKey = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
const keyOf = (s: BigIntStats): FileKey => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs });
const sameKey = (a: FileKey, b: FileKey) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** SHA-256 hex of an open file, read from its start in CHUNK_BYTES pieces (never whole in memory). */
async function hashHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  for (let position = 0; ; ) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

/** `workspaceDigest` of a manifest: its files' hashes and its directories (symbolic links are left out). */
export function manifestDigest(entries: readonly ManifestEntry[]): Promise<string> {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "file") lines.push(`file ${entry.path} ${entry.sha256}`);
    else if (entry.kind === "directory") lines.push(`directory ${entry.path}`);
  }
  return workspaceDigest(lines);
}
