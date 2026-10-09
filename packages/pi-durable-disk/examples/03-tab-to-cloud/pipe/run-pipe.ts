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
//   files in chunks, then the end; the tab checks every file against the manifest and says so.
//
// One tab writes at a time. A takeover gives the run to a new socket with a new epoch: the old socket is told it lost
// the run and every later frame of it is refused, after the frames it already sent have settled. Nothing of a retired
// writer lands in work/ after that: every rename into work/ checks, in the same turn, that its writer is still current.
// Viewers receive the writer's view events and the placement. A fence (the claim revoked, the mount failed, the lease
// lapsed) ends the pipe: every socket is told, nothing is retried.
import { createHash, randomBytes, type Hash } from "node:crypto";
import { constants, renameSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { FencedError, openArchilStore, openRunLease, storeHead } from "@parcha/pi-durable-disk";
import type { ArchilHost, ArchilStore, OpenRunLeaseOptions, RunLease, RunRef } from "@parcha/pi-durable-disk";
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
  /** A writer's unfinished uploads together may hold this many bytes; past it, an upload fails. Default 4 GiB. */
  readonly uploadLimitBytes?: number;
  /** A writer may have this many unfinished uploads; an upload past it is refused. Default 1024. */
  readonly maxUnfinishedUploads?: number;
  /** Test seams, passed to the lease. */
  readonly acquire?: OpenRunLeaseOptions["acquire"];
  readonly claimDir?: OpenRunLeaseOptions["claimDir"];
  /** Conformance mode: every writer gets a fresh scratch store under tmp/, opened like the run's. */
  readonly scratchStores?: boolean;
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
  /** The one upload whose file is open; a chunk of another closes it first, so uploads never pile up open files. */
  #openUpload: Upload | undefined;
  #scratch = 0;
  #drained: { switchId: string; done: () => void } | undefined;

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
  async attach(socket: PipeSocket, tab: string, takeover: boolean, extra: { environments: Environment[]; move?: Move; env?: string } = { environments: [] }): Promise<"writer" | "viewer"> {
    this.#assertUsable();
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
    const writer: Writer = { socket, epoch, tab, lastPing: Date.now(), inflight: new Set(), dead: false, closed: false, store, storage: this.lease.observe(store.storage), attachedAt: Date.now(), attaching: true };
    this.#writer = writer;
    this.#goneFired = false;
    // Every earlier writer is retired: an upload left in tmp/pipe-uploads/ (this pipe's, or a crashed one's) is stale.
    await this.#discardUploads(() => true);
    await rm(this.#uploadDir, { recursive: true, force: true });
    const manifest = await this.manifest();
    socket.send({
      t: "attached",
      epoch,
      generation: this.lease.generation,
      manifest: manifest.entries,
      model: this.#options.model.options.model,
      budget: { used: this.#options.model.spent, cap: this.#options.model.options.budgetTokens },
      environments: extra.environments,
      ...(extra.move ? { move: extra.move } : {}),
    });
    // Its grace starts now: its pings reach the pipe only once the attach is done.
    writer.attaching = false;
    writer.lastPing = Date.now();
    this.#broadcast({ t: "placement", placement: { where: "tab", tab, epoch, generation: this.lease.generation, env: extra.env ?? "tab" } });
    this.#log("pipe.attach", { tab, epoch, files: manifest.files, bytes: manifest.bytes, workDigest: await manifestDigest(manifest.entries) });
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
  async #streamRestore(writer: Writer, manifest: { entries: ManifestEntry[]; files: number; bytes: number }): Promise<void> {
    const socket = writer.socket;
    const stopped = () => writer.dead || socket.isOpen?.() === false;
    for (const entry of manifest.entries) {
      if (entry.kind !== "file" || entry.size === 0) continue;
      const handle = await open(join(this.lease.claim.work, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        for (let offset = 0; offset < entry.size; ) {
          while (!stopped() && (socket.bufferedAmount?.() ?? 0) > RESTORE_HIGH_WATER) await new Promise((r) => setTimeout(r, 5));
          if (stopped()) return;
          const length = Math.min(CHUNK_BYTES, entry.size - offset);
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead !== length) throw new Error(`${entry.path} is shorter than its manifest says`);
          socket.send({ t: "restore-chunk", path: entry.path, offset, data: buffer.toString("base64") });
          offset += length;
        }
      } finally {
        await handle.close();
      }
    }
    if (!stopped()) socket.send({ t: "restore-end", files: manifest.files, bytes: manifest.bytes });
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
  drained(socket: PipeSocket, switchId: string): void {
    if (this.#writer?.socket === socket && this.#drained?.switchId === switchId) this.#drained.done();
  }

  /** Whether `socket` is the attached writer's. */
  isWriter(socket: PipeSocket): boolean {
    return this.#writer !== undefined && !this.#writer.dead && this.#writer.socket === socket;
  }

  /** The socket closed: a writer's departure starts the grace; a viewer just leaves. */
  detach(socket: PipeSocket): void {
    this.#viewers.delete(socket);
    const writer = this.#writer;
    if (writer && writer.socket === socket && !writer.dead) writer.lastPing = Math.min(writer.lastPing, Date.now() - (this.#options.writerGraceMs ?? 3_000) + 250);
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
    for (const part of parts) {
      dir = join(dir, part);
      const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
      if (info === null) await mkdir(dir).catch((error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? undefined : Promise.reject(error)));
      else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${parts.join("/")} crosses ${part}, which is not a directory`);
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
      if (info.isDirectory()) await rm(target, { recursive: true, force: true });
      else await unlink(target);
      return;
    }
    // Written beside the target and renamed over it: a reader never sees half a file, and a symbolic link at the target
    // is replaced, never followed.
    const temp = join(dir, `.pipe-${randomBytes(6).toString("hex")}`);
    live();
    await writeFile(temp, fromBase64(change.data), { mode: (change.mode ?? 0o644) & 0o777 });
    await this.#replace(writer, temp, target);
  }

  /**
   * Put `temp` at `target` if `writer` is still the writer, else remove `temp` and throw. A directory at the target is
   * removed first, after the same check. The final check and the rename run in one turn (a synchronous rename), so a
   * writer retired while its write-through was in flight lands nothing.
   */
  async #replace(writer: Writer, temp: string, target: string): Promise<void> {
    try {
      const existing = await lstat(target).catch(() => null);
      if (existing?.isDirectory()) {
        this.#assertCurrent(writer);
        await rm(target, { recursive: true, force: true });
      }
      this.#assertCurrent(writer);
      renameSync(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
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
        this.heard(writer.socket);
      } catch (error) {
        u.failed = (error as Error).message;
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
      await this.#replace(writer, upload.file, join(dir, parts.at(-1)!));
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
  async manifest(): Promise<{ entries: ManifestEntry[]; files: number; bytes: number }> {
    const limit = this.#options.restoreLimitBytes ?? 1024 ** 3;
    const entries: ManifestEntry[] = [];
    let files = 0;
    let bytes = 0;
    await this.#walkWork(async (path, full, info) => {
      if (info.isSymbolicLink()) entries.push({ path, kind: "symlink", target: await readlink(full) });
      else if (info.isDirectory()) entries.push({ path, kind: "directory" });
      else {
        bytes += info.size;
        if (bytes > limit) throw new Error(`the workspace is larger than ${limit} bytes`);
        files++;
        entries.push({ path, kind: "file", size: info.size, sha256: await fileSha256(full), mode: info.mode & 0o777, mtimeMs: info.mtimeMs });
      }
    });
    return { entries, files, bytes };
  }

  /** work/ for viewers, with every file's content (as before chunked restore): nothing past VIEW_FILES_LIMIT. */
  async viewerFiles(): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    let bytes = 0;
    await this.#walkWork(async (path, full, info) => {
      if (info.isSymbolicLink()) out.push({ path, kind: "symlink", target: await readlink(full) });
      else if (info.isDirectory()) out.push({ path, kind: "directory" });
      else {
        bytes += info.size;
        if (bytes > VIEW_FILES_LIMIT) throw new Error(`the workspace is larger than ${VIEW_FILES_LIMIT} bytes`);
        out.push({ path, kind: "file", data: toBase64(await readFile(full)), mode: info.mode & 0o777, mtimeMs: info.mtimeMs });
      }
    });
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
    if (this.#viewers.size === 0) return;
    try {
      const files = await this.viewerFiles();
      this.#broadcast({ t: "files-changed", files }, false);
    } catch (error) {
      this.#log("pipe.files-broadcast-failed", { error: (error as Error).message });
    }
  }

  // ---- model -----------------------------------------------------------------------------------------------------------

  async model(socket: PipeSocket, id: number, path: string, body: Tagged): Promise<void> {
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
      }, abort.signal),
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
  async release(): Promise<void> {
    if (this.#released) return;
    if (this.#lost) throw this.#lost;
    clearInterval(this.#goneTimer);
    if (this.#writer) await this.#retire(this.#writer, "RELEASED", "the run was released");
    for (const abort of this.#models.values()) abort.abort();
    await this.#store?.storage.close(ctx);
    this.#released = true;
    // No upload outlives the pipe: the next holder of the claim (a cloud host's agent) never sees one.
    await this.#discardUploads(() => true);
    await rm(this.#uploadDir, { recursive: true, force: true }).catch(() => undefined);
    const digest = await this.workDigest().catch((error: Error) => `unreadable: ${error.message}`);
    const started = performance.now();
    await this.lease.release();
    this.#log("pipe.released", { ms: Math.round(performance.now() - started), workDigest: digest, generation: this.lease.generation });
  }

  /** `workspaceDigest` of work/ as the disk has it. */
  async workDigest(): Promise<string> {
    return manifestDigest((await this.manifest()).entries);
  }

  #assertUsable(): void {
    if (this.#lost) throw new PipeLostError("FENCED", `the pipe lost the run: ${this.#lost.message}`);
    if (this.#released) throw new PipeLostError("RELEASED", "the run was released");
  }
}

/** SHA-256 hex of a file, read in CHUNK_BYTES pieces (never whole in memory). */
async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
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
