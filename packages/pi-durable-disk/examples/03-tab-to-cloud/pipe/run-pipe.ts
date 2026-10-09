// The pipe of one run: it holds the run's claim (the package's lease: exclusive mount, owner lock, run.json heartbeat,
// self-fence) and pi's SqliteStorage on the mount, and serves the tab that runs the agent. It has no agent logic:
//
// - Storage: each Storage call of the tab's Session is one frame, dispatched to the store on the mount. A commit's
//   answer leaves only after SQLite's WAL fsync returned, so the tab never shows what the disk does not have.
// - Workspace write-through: after a tool, the tab sends the files it changed; they are written under work/, the mount
//   is synced (`archil sync`, the claim's barrier) and only then acknowledged, so the tool's result commits after its
//   files are durable.
// - Model calls: proxied to the model endpoint with a per-run token budget; the key never reaches the tab.
// - Restore: on attach, the tab gets work/ as the disk has it.
//
// One tab writes at a time. A takeover gives the run to a new socket with a new epoch: the old socket is told it lost
// the run and every later frame of it is refused, after the frames it already sent have settled. Viewers receive the
// writer's view events and the placement. A fence (the claim revoked, the mount failed, the lease lapsed) ends the pipe:
// every socket is told, nothing is retried.
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { FencedError, openArchilStore, openRunLease, storeHead } from "@parcha/pi-durable-disk";
import type { ArchilHost, ArchilStore, OpenRunLeaseOptions, RunLease, RunRef } from "@parcha/pi-durable-disk";
import type { ModelProxy } from "./model-proxy.ts";
import {
  errorToWire,
  fromBase64,
  PipeLostError,
  STORAGE_METHODS,
  tag,
  toBase64,
  untag,
  workspaceDigest,
  type FileChange,
  type FileEntry,
  type PipeFrame,
  type StorageMethod,
  type Tagged,
} from "../wire.ts";

/** What the pipe needs of a socket; the server adapts a WebSocket to it. */
export interface PipeSocket {
  readonly id: string;
  send(frame: PipeFrame): void;
  close(code: number, reason: string): void;
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
  /** Restore refuses a workspace larger than this. Default 64 MiB. */
  readonly restoreLimitBytes?: number;
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
};

const VIEW_BUFFER = 4_000;
const SEGMENT = /^[^/\0]+$/;

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
  #scratch = 0;
  readonly timings: { commits: number[]; files: number[] } = { commits: [], files: [] };

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
  async attach(socket: PipeSocket, tab: string, takeover: boolean): Promise<"writer" | "viewer"> {
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
    const writer: Writer = { socket, epoch, tab, lastPing: Date.now(), inflight: new Set(), dead: false, closed: false, store, storage: this.lease.observe(store.storage) };
    this.#writer = writer;
    this.#goneFired = false;
    const files = await this.restoreManifest();
    socket.send({
      t: "attached",
      epoch,
      generation: this.lease.generation,
      files,
      model: this.#options.model.options.model,
      budget: { used: this.#options.model.spent, cap: this.#options.model.options.budgetTokens },
    });
    this.#broadcast({ t: "placement", placement: { where: "tab", tab, epoch, generation: this.lease.generation } });
    this.#log("pipe.attach", { tab, epoch, files: files.length, workDigest: await this.workDigest() });
    return "writer";
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

  /** The socket closed: a writer's departure starts the grace; a viewer just leaves. */
  detach(socket: PipeSocket): void {
    this.#viewers.delete(socket);
    const writer = this.#writer;
    if (writer && writer.socket === socket && !writer.dead) writer.lastPing = Math.min(writer.lastPing, Date.now() - (this.#options.writerGraceMs ?? 3_000) + 250);
  }

  ping(socket: PipeSocket, at: number): void {
    const writer = this.#writer;
    if (writer && writer.socket === socket && !writer.dead) writer.lastPing = Date.now();
    socket.send({ t: "pong", at, now: Date.now() });
  }

  #gcTimer(): void {
    this.#goneTimer = setInterval(() => {
      const writer = this.#writer;
      if (!writer || writer.dead || this.#goneFired || this.#lost || this.#released) return;
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
      const ms = performance.now() - started;
      if (method === "commit") this.timings.commits.push(ms);
      socket.send({ t: "res", id, ok: true, result: tag(result), ms });
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
      for (const change of changes) await this.#apply(change);
      await this.lease.barrier();
    })());
    try {
      await work;
      if (writer.dead) throw new PipeLostError("MOVED", "the run moved to another device");
      const ms = performance.now() - started;
      this.timings.files.push(ms);
      socket.send({ t: "res", id, ok: true, result: tag({ applied: changes.length }), ms });
      if (changes.length > 0) this.#broadcastFiles();
    } catch (error) {
      if (error instanceof FencedError) this.lostRun(error);
      const lost = this.#lost ? new PipeLostError("FENCED", `the pipe lost the run: ${this.#lost.message}`) : error;
      socket.send({ t: "res", id, ok: false, error: errorToWire(lost) });
    }
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

  async #apply(change: FileChange): Promise<void> {
    const parts = RunPipe.segments(change.path);
    const name = parts.at(-1)!;
    if (change.op === "mkdir") {
      await this.#dirAt(parts);
      return;
    }
    const dir = await this.#dirAt(parts.slice(0, -1));
    const target = join(dir, name);
    if (change.op === "delete") {
      const info = await lstat(target).catch(() => null);
      if (info === null) return;
      if (info.isDirectory()) await rm(target, { recursive: true, force: true });
      else await unlink(target);
      return;
    }
    const existing = await lstat(target).catch(() => null);
    if (existing?.isDirectory()) await rm(target, { recursive: true, force: true });
    // Written beside the target and renamed over it: a reader never sees half a file, and a symbolic link at the target
    // is replaced, never followed.
    const temp = join(dir, `.pipe-${randomBytes(6).toString("hex")}`);
    await writeFile(temp, fromBase64(change.data), { mode: (change.mode ?? 0o644) & 0o777 });
    await rename(temp, target);
  }

  /** work/ as the disk has it: every file's content, every directory, symbolic links as their target text. */
  async restoreManifest(): Promise<FileEntry[]> {
    const limit = this.#options.restoreLimitBytes ?? 64 * 1024 * 1024;
    const out: FileEntry[] = [];
    let bytes = 0;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const names = (await readdir(dir)).sort();
      for (const name of names) {
        if (prefix === "" && name.startsWith(".pipe-")) continue;
        const path = prefix === "" ? name : `${prefix}/${name}`;
        const full = join(dir, name);
        const info = await lstat(full);
        if (info.isSymbolicLink()) out.push({ path, kind: "symlink", target: await readlink(full) });
        else if (info.isDirectory()) {
          out.push({ path, kind: "directory" });
          await walk(full, path);
        } else if (info.isFile()) {
          if (name.startsWith(".pipe-")) continue;
          bytes += info.size;
          if (bytes > limit) throw new Error(`the workspace is larger than ${limit} bytes`);
          out.push({ path, kind: "file", data: toBase64(await readFile(full)), mode: info.mode & 0o777, mtimeMs: info.mtimeMs });
        }
      }
    };
    await walk(this.lease.claim.work, "");
    return out;
  }

  async #broadcastFiles(): Promise<void> {
    if (this.#viewers.size === 0) return;
    try {
      const files = await this.restoreManifest();
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
    if (this.#writer && !this.#writer.dead) {
      this.#writer.dead = true;
      try {
        this.#writer.socket.send(frame);
        this.#writer.socket.close(4002, "FENCED");
      } catch {
        // gone
      }
    }
    this.#broadcast({ t: "placement", placement: { where: "moving", to: "cloud", detail: "the claim was taken" } });
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
    const digest = await this.workDigest().catch((error: Error) => `unreadable: ${error.message}`);
    const started = performance.now();
    await this.lease.release();
    this.#log("pipe.released", { ms: Math.round(performance.now() - started), workDigest: digest, generation: this.lease.generation });
  }

  /** `workspaceDigest` of work/ as the disk has it. */
  async workDigest(): Promise<string> {
    const lines: string[] = [];
    for (const entry of await this.restoreManifest()) {
      if (entry.kind === "file") lines.push(`file ${entry.path} ${createHash("sha256").update(fromBase64(entry.data)).digest("hex")}`);
      else if (entry.kind === "directory") lines.push(`directory ${entry.path}`);
    }
    return workspaceDigest(lines);
  }

  #assertUsable(): void {
    if (this.#lost) throw new PipeLostError("FENCED", `the pipe lost the run: ${this.#lost.message}`);
    if (this.#released) throw new PipeLostError("RELEASED", "the run was released");
  }
}
