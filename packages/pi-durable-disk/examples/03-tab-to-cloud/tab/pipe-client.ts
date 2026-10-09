// The tab's end of the pipe: one WebSocket, a Storage whose every call is one frame, the workspace write-through call,
// and a `fetch` for model calls that the pipe proxies. Portable: the page and Node (a remote host, tests) run it; it
// needs a global WebSocket, or a socket already open (one the server dialed into a remote host).
import type { Storage } from "@earendil-works/pi-durable";
import {
  errorFromWire,
  PipeLostError,
  tag,
  untag,
  type FileChange,
  type FileEntry,
  type PipeFrame,
  type StorageMethod,
  type TabFrame,
  type Tagged,
} from "../wire.ts";

export type Attached = Extract<PipeFrame, { t: "attached" }>;
export type Viewing = Extract<PipeFrame, { t: "viewing" }>;

/** The WebSocket API the client uses: a browser's, Node's global one, or a `ws` socket. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
}

const OPEN = 1;

export interface PipeClientOptions {
  /** Where the pipe listens; or `socket`, already open. */
  readonly url?: string;
  readonly socket?: SocketLike;
  readonly run: string;
  readonly token: string;
  readonly tab: string;
  readonly mode: "write" | "view";
  readonly takeover?: boolean;
  /** The switch this tab answers (the pipe told it to run the run here). */
  readonly switchId?: string;
  /** Ping period; the pipe considers the writer gone after a few missed pings. Default 1 s. */
  readonly pingMs?: number;
  readonly onFrame?: (frame: PipeFrame) => void;
  readonly onLost?: (code: string, message: string) => void;
}

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
        this.#send({ t: "hello", run: options.run, token: options.token, mode: options.mode, tab: options.tab, ...(options.takeover ? { takeover: true } : {}), ...(options.switchId ? { switchId: options.switchId } : {}) });
        this.#ping = setInterval(() => this.#send({ t: "ping", at: performance.now() }), options.pingMs ?? 1_000);
      };
      if (this.#socket.readyState === OPEN) queueMicrotask(hello);
      else this.#socket.addEventListener("open", hello);
      this.#socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as PipeFrame;
        if (frame.t === "attached" || frame.t === "viewing") resolve(frame);
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
      default:
        this.options.onFrame?.(frame);
    }
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

  /** Send workspace changes; resolves once the pipe wrote them and synced the mount. */
  async syncFiles(changes: FileChange[]): Promise<void> {
    if (this.#lost) throw this.#lost;
    const id = this.#next++;
    const started = performance.now();
    const pending = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    const entry = this.#pending.get(id)!;
    this.#send({ t: "files", id, changes });
    await pending;
    this.timings.files.push({ server: entry.ms ?? 0, client: performance.now() - started });
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
