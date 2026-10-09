// The tab's end of the pipe: one WebSocket, a Storage whose every call is one frame, the workspace write-through call,
// and a `fetch` for model calls that the pipe proxies. Portable: the page and Node (a remote host, tests) run it; it
// needs a global WebSocket, or a socket already open (one the server dialed into a remote host).
//
// No frame carries more than CHUNK_BYTES of file content: an attach's workspace arrives as a manifest and chunks, and is
// handed over (`ready`) only once every file matches its manifest SHA-256; a write-through sends a large file ahead as
// an upload in chunks and names it.
import type { Storage } from "@earendil-works/pi-durable";
import {
  CHUNK_BYTES,
  errorFromWire,
  fromBase64,
  PipeLostError,
  sha256Hex,
  tag,
  toBase64,
  untag,
  type FileChange,
  type FileEntry,
  type LocalWrite,
  type ManifestEntry,
  type PipeFrame,
  type RestoredEntry,
  type StorageMethod,
  type TabFrame,
  type Tagged,
} from "../wire.ts";

/** The writer's attachment as `ready` hands it over: the workspace restored, every file checked. */
export type Attached = Omit<Extract<PipeFrame, { t: "attached" }>, "manifest"> & { files: RestoredEntry[] };
export type Viewing = Extract<PipeFrame, { t: "viewing" }>;

/** The WebSocket API the client uses: a browser's, Node's global one, or a `ws` socket. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  /** Bytes queued and not yet sent (a browser's WebSocket and `ws` both have it); uploads wait while it is high. */
  readonly bufferedAmount?: number;
}

const OPEN = 1;
/** An upload waits while this much is queued on the socket. */
const HIGH_WATER = 4 * CHUNK_BYTES;
/** The default restore limit of a host (the tab's page passes a smaller one). */
export const RESTORE_LIMIT_BYTES = 1024 ** 3;

export interface PipeClientOptions {
  /** Where the pipe listens; or `socket`, already open. */
  readonly url?: string;
  readonly socket?: SocketLike;
  readonly run: string;
  readonly token: string;
  readonly tab: string;
  readonly mode: "write" | "view" | "operator";
  /** This client is a page that can run the agent when the pipe tells it to (a switch into a tab). */
  readonly canRun?: boolean;
  readonly takeover?: boolean;
  /** The switch this tab answers (the pipe told it to run the run here). */
  readonly switchId?: string;
  /** Ping period; the pipe considers the writer gone after a few missed pings. Default 1 s. */
  readonly pingMs?: number;
  readonly onFrame?: (frame: PipeFrame) => void;
  readonly onLost?: (code: string, message: string) => void;
  /** An attach whose workspace is larger than this fails (RESTORE_FAILED) before anything is received. Default 1 GiB. */
  readonly restoreLimitBytes?: number;
}

/** A restore in progress: the attach frame, and each manifest file's bytes as they arrive. */
type Restore = { frame: Extract<PipeFrame, { t: "attached" }>; files: Map<string, { entry: Extract<ManifestEntry, { kind: "file" }>; bytes: Uint8Array; received: number }>; started: number };

type Pending = { resolve(value: unknown): void; reject(error: Error): void; ms?: number };
type ModelStream = { head(status: number): void; push(text: string): void; end(status: number, error?: string): void };

export class PipeClient {
  readonly options: PipeClientOptions;
  #socket: SocketLike;
  #next = 1;
  #pending = new Map<number, Pending>();
  #models = new Map<number, ModelStream>();
  #lost: PipeLostError | undefined;
  #ping: ReturnType<typeof setInterval> | undefined;
  #settle: { resolve(value: Attached | Viewing): void; reject(error: Error): void } | undefined;
  #restore: Restore | undefined;
  /** Round trips measured by pings, in ms. */
  readonly rtts: number[] = [];
  /** Server-side and client-side duration of each commit and each write-through, in ms. */
  readonly timings: { commit: { server: number; client: number }[]; files: { server: number; client: number }[] } = { commit: [], files: [] };
  readonly ready: Promise<Attached | Viewing>;

  constructor(options: PipeClientOptions) {
    this.options = options;
    if (!options.socket && !options.url) throw new Error("a PipeClient needs a url or an open socket");
    this.#socket = options.socket ?? (new WebSocket(options.url!) as unknown as SocketLike);
    this.ready = new Promise((resolve, reject) => {
      const hello = () => {
        this.#send({ t: "hello", run: options.run, token: options.token, mode: options.mode, tab: options.tab, ...(options.takeover ? { takeover: true } : {}), ...(options.switchId ? { switchId: options.switchId } : {}), ...(options.canRun ? { canRun: true } : {}) });
        this.#ping = setInterval(() => this.#send({ t: "ping", at: performance.now() }), options.pingMs ?? 1_000);
      };
      if (this.#socket.readyState === OPEN) queueMicrotask(hello);
      else this.#socket.addEventListener("open", hello);
      this.#settle = { resolve, reject };
      this.#socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as PipeFrame;
        if (frame.t === "viewing") resolve(frame);
        this.#onFrame(frame);
      });
      this.#socket.addEventListener("close", (event) => {
        clearInterval(this.#ping);
        this.#lose("CLOSED", `the pipe closed (${event.code} ${event.reason})`);
        reject(this.#lost);
      });
      this.#socket.addEventListener("error", () => undefined);
    });
  }

  get lost(): PipeLostError | undefined {
    return this.#lost;
  }

  #send(frame: TabFrame): void {
    if (this.#socket.readyState === OPEN) this.#socket.send(JSON.stringify(frame));
  }

  send(frame: TabFrame): void {
    this.#send(frame);
  }

  #lose(code: string, message: string): void {
    if (this.#lost) return;
    this.#lost = new PipeLostError(code, message);
    for (const pending of this.#pending.values()) pending.reject(this.#lost);
    this.#pending.clear();
    for (const stream of this.#models.values()) stream.end(499, message);
    this.#models.clear();
    this.options.onLost?.(code, message);
  }

  #onFrame(frame: PipeFrame): void {
    switch (frame.t) {
      case "res": {
        const pending = this.#pending.get(frame.id);
        if (!pending) return;
        this.#pending.delete(frame.id);
        if (frame.ok) {
          pending.ms = frame.ms;
          pending.resolve(untag(frame.result));
        } else pending.reject(errorFromWire(frame.error));
        return;
      }
      case "model-head":
        this.#models.get(frame.id)?.head(frame.status);
        return;
      case "model-chunk":
        this.#models.get(frame.id)?.push(frame.data);
        return;
      case "model-end":
        this.#models.get(frame.id)?.end(frame.status, frame.error);
        this.#models.delete(frame.id);
        return;
      case "pong":
        this.rtts.push(performance.now() - frame.at);
        if (this.rtts.length > 1000) this.rtts.shift();
        return;
      case "lost":
        this.#lose(frame.code, frame.message);
        this.options.onFrame?.(frame);
        return;
      case "attached":
        this.#startRestore(frame);
        return;
      case "restore-chunk":
        this.#restoreChunk(frame);
        return;
      case "restore-end":
        void this.#finishRestore(frame);
        return;
      default:
        this.options.onFrame?.(frame);
    }
  }

  #startRestore(frame: Extract<PipeFrame, { t: "attached" }>): void {
    const limit = this.options.restoreLimitBytes ?? RESTORE_LIMIT_BYTES;
    const files: Restore["files"] = new Map();
    let bytes = 0;
    for (const entry of frame.manifest) if (entry.kind === "file") bytes += entry.size;
    if (bytes > limit) return this.#restoreFailed(`the workspace is ${bytes} bytes, over this host's limit of ${limit}`);
    for (const entry of frame.manifest) if (entry.kind === "file") files.set(entry.path, { entry, bytes: new Uint8Array(entry.size), received: 0 });
    this.#restore = { frame, files, started: performance.now() };
  }

  #restoreChunk(frame: Extract<PipeFrame, { t: "restore-chunk" }>): void {
    const restore = this.#restore;
    if (!restore) return;
    const file = restore.files.get(frame.path);
    if (!file) return this.#restoreFailed(`a chunk of ${JSON.stringify(frame.path)}, which the manifest does not list`);
    const data = fromBase64(frame.data);
    if (frame.offset !== file.received || file.received + data.length > file.entry.size) {
      return this.#restoreFailed(`${frame.path}: a chunk at byte ${frame.offset} of ${data.length} bytes, after ${file.received} of ${file.entry.size}`);
    }
    file.bytes.set(data, frame.offset);
    file.received += data.length;
  }

  /** The restore is whole: every file checked against its size and SHA-256, the pipe told, `ready` resolved. */
  async #finishRestore(frame: Extract<PipeFrame, { t: "restore-end" }>): Promise<void> {
    const restore = this.#restore;
    if (!restore) return;
    this.#restore = undefined;
    let bytes = 0;
    for (const file of restore.files.values()) {
      if (file.received !== file.entry.size) return this.#restoreFailed(`${file.entry.path}: ${file.received} of ${file.entry.size} bytes arrived`);
      if ((await sha256Hex(file.bytes)) !== file.entry.sha256) return this.#restoreFailed(`${file.entry.path}: its content does not match the manifest's SHA-256`);
      bytes += file.received;
    }
    if (restore.files.size !== frame.files || bytes !== frame.bytes) return this.#restoreFailed(`the pipe sent ${frame.files} files of ${frame.bytes} bytes, the manifest lists ${restore.files.size} of ${bytes}`);
    const files: RestoredEntry[] = restore.frame.manifest.map((entry) => {
      if (entry.kind !== "file") return entry;
      return { path: entry.path, kind: "file", bytes: restore.files.get(entry.path)!.bytes, mode: entry.mode, mtimeMs: entry.mtimeMs };
    });
    const ms = performance.now() - restore.started;
    this.#send({ t: "restored", ok: true, files: restore.files.size, bytes, ms: Math.round(ms) });
    const { manifest: _manifest, ...attached } = restore.frame;
    this.#settle?.resolve({ ...attached, files });
  }

  /** Nothing of the restore is handed over: the pipe is told why, the client is lost, `ready` rejects. */
  #restoreFailed(message: string): void {
    this.#restore = undefined;
    this.#send({ t: "restored", ok: false, error: message });
    this.#lose("RESTORE_FAILED", message);
    this.#settle?.reject(this.#lost!);
    this.#socket.close(4005, "RESTORE_FAILED");
  }

  async call(method: StorageMethod, args: unknown[]): Promise<unknown> {
    if (this.#lost) throw this.#lost;
    const id = this.#next++;
    const started = performance.now();
    const pending = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    const entry = this.#pending.get(id)!;
    this.#send({ t: "rpc", id, method, args: args.map(tag) });
    const value = await pending;
    if (method === "commit") this.timings.commit.push({ server: entry.ms ?? 0, client: performance.now() - started });
    return value;
  }

  /**
   * Send workspace changes; resolves once the pipe wrote them and synced the mount. Inline content stays under
   * CHUNK_BYTES per call; a write past that goes ahead as an upload, which the pipe renames into place only if it
   * arrived whole.
   */
  async syncFiles(changes: readonly (FileChange | LocalWrite)[]): Promise<void> {
    if (this.#lost) throw this.#lost;
    const sent: FileChange[] = [];
    let inline = 0;
    for (const change of changes) {
      if (change.op !== "write" || "upload" in change) {
        sent.push(change);
        continue;
      }
      const meta = { ...(change.mode === undefined ? {} : { mode: change.mode }), ...(change.mtimeMs === undefined ? {} : { mtimeMs: change.mtimeMs }) };
      const size = "bytes" in change ? change.bytes.length : Math.floor((change.data.length * 3) / 4);
      if (inline + size <= CHUNK_BYTES) {
        sent.push({ path: change.path, op: "write", data: "bytes" in change ? toBase64(change.bytes) : change.data, ...meta });
        inline += size;
      } else {
        const bytes = "bytes" in change ? change.bytes : fromBase64(change.data);
        sent.push({ path: change.path, op: "write", upload: await this.#upload(bytes), ...meta });
      }
    }
    if (this.#lost) throw this.#lost;
    const id = this.#next++;
    const started = performance.now();
    const pending = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    const entry = this.#pending.get(id)!;
    this.#send({ t: "files", id, changes: sent });
    await pending;
    this.timings.files.push({ server: entry.ms ?? 0, client: performance.now() - started });
  }

  /** Send `bytes` as an upload, in order, CHUNK_BYTES at a time, waiting while the socket is backed up. */
  async #upload(bytes: Uint8Array): Promise<{ id: string; size: number; sha256: string }> {
    const random = crypto.getRandomValues(new Uint8Array(12));
    let id = "";
    for (const b of random) id += b.toString(16).padStart(2, "0");
    const sha256 = await sha256Hex(bytes);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      while (!this.#lost && (this.#socket.bufferedAmount ?? 0) > HIGH_WATER) await new Promise((r) => setTimeout(r, 5));
      if (this.#lost) throw this.#lost;
      this.#send({ t: "upload", id, offset, data: toBase64(bytes.subarray(offset, offset + CHUNK_BYTES)) });
    }
    return { id, size: bytes.length, sha256 };
  }

  /** A view event for the run's viewers (what this page shows). */
  view(event: unknown): void {
    this.#send({ t: "view", event: tag(event) });
  }

  /**
   * A `fetch` for an OpenAI-compatible provider: the request body goes to the pipe, which sends it to the model with its
   * own credentials and streams the response back. Only the URL's path under `/v1/` travels; the pipe knows the endpoint.
   */
  readonly fetch = async (input: unknown, init?: { body?: unknown; signal?: AbortSignal | null }): Promise<Response> => {
    if (this.#lost) throw this.#lost;
    const id = this.#next++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url ?? "");
    const path = new URL(url, "http://x").pathname.replace(/^.*\/v1\//, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    let resolveHead!: (status: number) => void;
    const head = new Promise<number>((resolve) => (resolveHead = resolve));
    // The reader may cancel the body before the pipe ends it (the SDK stops at the response's last event).
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        this.#models.set(id, {
          head: (code) => resolveHead(code),
          push: (text) => {
            if (open) controller.enqueue(encoder.encode(text));
          },
          end: (code, error) => {
            // Without a head the request failed before the model answered: the error is the whole body.
            resolveHead(code);
            if (!open) return;
            open = false;
            if (code >= 400 && error) controller.enqueue(encoder.encode(JSON.stringify({ error: { message: error } })));
            controller.close();
          },
        });
      },
      cancel: () => {
        open = false;
        this.#models.delete(id);
        this.#send({ t: "model-abort", id });
      },
    });
    init?.signal?.addEventListener("abort", () => this.#send({ t: "model-abort", id }), { once: true });
    this.#send({ t: "model", id, path, body: tag(body) });
    const code = await head;
    return new Response(stream, { status: code, headers: { "content-type": code < 400 ? "text/event-stream" : "application/json" } });
  };

  close(): void {
    clearInterval(this.#ping);
    this.#send({ t: "bye" });
    this.#socket.close(1000, "bye");
  }
}

/** pi's Storage over the pipe: every method is one frame; the Context stays in the tab. */
export function remoteStorage(client: PipeClient): Storage {
  return new Proxy({} as Storage, {
    get(_target, method) {
      if (method === "then" || typeof method !== "string") return undefined;
      return (...args: unknown[]) => {
        const sent = method === "mintId" ? args : args.slice(0, -1);
        return client.call(method as StorageMethod, sent);
      };
    },
  });
}

export type { FileChange, FileEntry, Tagged };
