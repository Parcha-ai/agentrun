// A fake provider backend for every test of the package and of a host that composes it. One object keeps the truth
// (sessions, a ledger of every call in arrival order); three faces read it:
//   - `provider`  the in-process BrowserProvider, for unit and composition tests;
//   - `broker`    a host CredentialBroker, with the fill counted before any provider call, as the real one does;
//   - `serve()`   the same backend over HTTP in a parent process, with `remoteProvider(url)` as the child's client,
//                 so the ledger outlives a child that is SIGKILLed (the crash matrix).
// Knobs make it misbehave the way real providers do: hold an op after it was applied and before it was answered (a
// crash between the provider acting and the caller hearing), fail an op, delay it, and echo the request and every
// secret it holds in the failure text, as vendor SDKs do. Every secret it holds is a sentinel.
import { EventEmitter } from "node:events";
import { crc32 } from "node:zlib";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AttachTarget, BrowserProvider, FetchRequest, FetchResult, LiveView, ProviderCaps, RemoteFile, SearchRequest, SearchResult, SessionSpec } from "../core/host.js";
import type { LeaseRef, ResourceStatus } from "../core/lease.js";
import { makeSentinels, type Sentinels } from "./sentinels.js";

/** A page that answers by format: each side is the page, or the HTTP status the provider fails it with. */
export type FakeFetchByFormat = { markdown?: { contentType: string; content: string } | { status: number }; raw?: { contentType: string; content: string } | { status: number } };

/** A failure the way a vendor SDK reports one: a message and the HTTP status on the error, never inside the text. */
export class FakeProviderError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "FakeProviderError";
    this.status = status;
  }
}

export type LedgerRow = { n: number; op: string; [field: string]: unknown };
export type FixturePage = { url: string; title: string; text: string; html: string };
/** A page the driver serves; `html` defaults to the text in one paragraph. */
export const fixturePage = (url: string, text: string, title = "Fixture"): FixturePage => ({ url, title, text, html: `<main><p>${text}</p></main>` });

export type BrokerConnection = { name: string; startUrl: string | null; fields: Array<{ name: string; type: "text" | "email" | "password" | "totp" }>; allowedOrigins: string[]; enrollment: boolean };
export type FillRequest = { pageUrl: string; fields: Array<{ field: string; selector: string }> };
export type FillResult = { status: "completed" | "failed" | "unknown"; fields: Array<{ index: number; status: string; errorCode?: string }> };

export type FakeBackendOptions = {
  sentinels?: Sentinels;
  name?: string;
  caps?: Partial<ProviderCaps>;
  /** The URL a new session starts on. */
  start?: string;
  pages?: Record<string, FixturePage>;
  /** `fetch` answers by URL; a URL not listed is a 404. */
  /** Each URL's page; an object answers a markdown and a raw request apart (a 400 where the provider will not convert). */
  fetches?: Record<string, string | FakeFetchByFormat>;
  search?: SearchResult["results"];
  /** Every ledger row is also appended here as JSONL, so a killed process leaves its calls behind. */
  logFile?: string;
  connections?: BrokerConnection[];
  downloads?: Record<string, string>;
  /** The page's CSS viewport and its full-page height; screenshots are this size in pixels. */
  viewport?: { width: number; height: number };
  fullPageHeight?: number;
  /** Device pixels per CSS pixel; a screenshot is this many times larger unless it asks for `scale: "css"`. */
  deviceScale?: number;
};

export type FakeScreenshotOptions = { fullPage?: boolean; type?: "png" | "jpeg"; quality?: number; scale?: "css" | "device" };

/** An image whose header declares `width` x `height`: a PNG (signature, IHDR with its CRC, IEND) or a JPEG (SOI, one
 *  start-of-frame, EOI). Enough for a reader that decodes the header; not a picture. */
export function fakeImage(type: "png" | "jpeg", width: number, height: number): Buffer {
  if (type === "jpeg") {
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
  }
  const chunk = (kind: string, data: Buffer) => {
    const head = Buffer.concat([Buffer.from(kind, "ascii"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(head));
    return Buffer.concat([length, head, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
}

const DEFAULT_CAPS: ProviderCaps = { timeoutModel: "inactivity", maxLifetimeS: 3600, survivesDisconnect: false, releaseIsAsync: false, extension: "loaded-locally" };

type Session = { id: string; tag: string; metadata: Record<string, string>; state: "running" | "stopped"; url: string; broker: boolean; plane: string };

export class FakeBackend {
  readonly sentinels: Sentinels;
  readonly pages: Record<string, FixturePage>;
  /** Every call to the provider or broker, in arrival order: what a test asserts the run did. */
  readonly ledger: LedgerRow[] = [];
  /** Every call the driver made on a page, in order; a read answered from a receipt never shows up here. */
  readonly dispatched: Array<{ op: string; session: string; url: string | null; [field: string]: unknown }> = [];
  /** Emits `held` with the op name when a held call has been applied and will never be answered. */
  readonly events = new EventEmitter();
  readonly sessions = new Map<string, Session>();
  readonly provider: BrowserProvider;
  readonly broker: FakeBroker;
  /** The driver's operations by session id; `fakeDriver` and `remoteDriver` are its two callers. */
  readonly driverFace: FakeDriverFace;
  private seq = 0;
  private holdOp: string | null = null;
  private loseOp: string | null = null;
  private failures = new Map<string, number>();
  private delays = new Map<string, number>();
  private peak = 0;
  private echoOn = false;
  readonly opts: Required<Pick<FakeBackendOptions, "start" | "fetches" | "search" | "connections" | "downloads">> & FakeBackendOptions;

  constructor(options: FakeBackendOptions = {}) {
    this.sentinels = options.sentinels ?? makeSentinels();
    this.pages = options.pages ?? {};
    this.opts = {
      ...options,
      start: options.start ?? "about:blank",
      fetches: options.fetches ?? {},
      search: options.search ?? [],
      downloads: options.downloads ?? {},
      connections: options.connections ?? [{ name: "demo", startUrl: "https://login.sentinel.test/", fields: [{ name: "username", type: "text" }, { name: "password", type: "password" }, { name: "otp", type: "totp" }], allowedOrigins: ["https://login.sentinel.test"], enrollment: true }],
    };
    this.provider = this.makeProvider(options.name ?? "fake", { ...DEFAULT_CAPS, ...options.caps });
    this.broker = new FakeBroker(this);
    this.driverFace = new FakeDriverFace(this);
  }

  // ---- knobs -----------------------------------------------------------------------------------------------------

  /** The next call of `op` is applied and recorded, then never answered. */
  hold(op: string): void { this.holdOp = op; }
  /** The next call of `op` is applied and recorded, then fails: the provider did the work and the answer was lost. */
  lose(op: string): void { this.loseOp = op; }
  /** The next `times` calls of `op` fail before they take effect. */
  fail(op: string, times = 1): void { this.failures.set(op, times); }
  /** `op` sleeps `ms` before it takes effect; a caller that hangs up meanwhile is not served. */
  delay(op: string, ms: number): void { this.delays.set(op, ms); }
  /** Failure text repeats the request and every secret the backend holds. */
  echo(on = true): void { this.echoOn = on; }
  /** The provider ended every running session (Browserbase does when the client disconnects without keepAlive). */
  endAll(): void { for (const s of this.sessions.values()) s.state = "stopped"; }
  goto(url: string): void { for (const s of this.sessions.values()) if (s.state === "running") s.url = url; }
  reset(): void {
    this.sessions.clear(); this.ledger.length = 0; this.dispatched.length = 0; this.seq = 0; this.holdOp = null; this.loseOp = null; this.failures.clear(); this.delays.clear(); this.peak = 0; this.echoOn = false;
  }

  live(): Array<{ id: string; tag: string }> { return [...this.sessions.values()].filter((s) => s.state === "running").map(({ id, tag }) => ({ id, tag })); }
  liveCount(): number { return this.live().length; }

  /** Counts per op, and the most sessions that were live at once. */
  tally() {
    const count = (op: string) => this.ledger.filter((r) => r.op === op).length;
    return {
      creates: count("create"), findByTag: count("findByTag"), status: count("status"), attaches: count("attach"), releases: count("release"), releaseNoops: count("release-noop"),
      fetches: count("fetch"), searches: count("search"), dispatches: this.dispatched.filter((d) => d.op === "run").length, reads: this.dispatched.filter((d) => d.op === "read").length,
      peakLive: this.peak, liveAtEnd: this.liveCount(),
    };
  }

  // ---- internals shared by the faces ---------------------------------------------------------------------------------

  /**
   * What a failing vendor puts in its error: the request's credentials and the connect URLs it holds. A broker's
   * error also repeats the login values, TOTP seed and vault reference it was handling; those are never known to the
   * package, so only a provider that maps broker errors to codes (never copies their text) keeps them out.
   */
  echoText(op: string): string {
    const s = this.sentinels;
    const vendor = `${op} failed: authorization=Bearer ${s.runToken} x-bb-api-key=${s.bbApiKey} connect=${s.bbConnectUrl} cdp=${s.kernelCdpUrl}`;
    return op.startsWith("broker.") ? `${vendor} user=${s.loginUsername} password=${s.loginPassword} totp=${s.totpSeed} vault=${s.vaultRef}` : vendor;
  }

  record(op: string, fields: Record<string, unknown> = {}): LedgerRow {
    const row: LedgerRow = { n: this.ledger.length + 1, op, ...fields };
    this.ledger.push(row);
    if (this.opts.logFile) fs.appendFileSync(this.opts.logFile, `${JSON.stringify(row)}\n`);
    return row;
  }

  /** Before an op takes effect: honor the caller's signal, sleep the delay, fail when told to. */
  async before(op: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const ms = this.delays.get(op);
    if (ms) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    }
    const left = this.failures.get(op) ?? 0;
    if (left > 0) {
      this.failures.set(op, left - 1);
      this.record(`${op}-failed`);
      throw new FakeProviderError(this.echoOn ? this.echoText(op) : `${op} failed: provider unavailable`);
    }
  }

  /** After an op took effect: when it is the held one, announce it and never answer. */
  async after(op: string): Promise<void> {
    if (this.loseOp === op) { this.loseOp = null; throw new FakeProviderError(`${op} was applied and its answer was lost`); }
    if (this.holdOp !== op) return;
    this.holdOp = null;
    this.events.emit("held", op);
    await new Promise<never>(() => {});
  }

  noteLive(): void { this.peak = Math.max(this.peak, this.liveCount()); }
  newId(prefix: string): string { this.seq += 1; return `${prefix}-${this.seq}`; }
  running(id: string): Session | null { const s = this.sessions.get(id); return s && s.state === "running" ? s : null; }

  /** The attach target of a session: the connect URL carries the signing key (the driver's, and nobody else's). */
  targetOf(session: Session): AttachTarget {
    const url = this.sentinels.bbConnectUrl.replace(/sessionId=[^&]+/, `sessionId=${session.id}`);
    if (!session.broker) return { sdkCdpUrl: url };
    return { sdkCdpUrl: `ws://127.0.0.1:1/vm-local/?sessionId=${session.id}`, dial: { url: this.sentinels.kernelCdpUrl, headers: { Authorization: `Bearer ${this.sentinels.brokerCapability}` } } };
  }

  private makeProvider(name: string, caps: ProviderCaps): BrowserProvider {
    const b = this;
    return {
      name,
      caps,
      async create(spec: SessionSpec, signal: AbortSignal): Promise<LeaseRef> {
        await b.before("create", signal);
        const id = b.newId("fake_sess");
        b.sessions.set(id, { id, tag: spec.tag, metadata: { ...spec.metadata }, state: "running", url: b.opts.start, broker: false, plane: "default" });
        b.noteLive();
        b.record("create", { id, tag: spec.tag, metadata: { ...spec.metadata }, contextId: spec.contextId ?? null, verified: spec.verified, liveNow: b.liveCount() });
        await b.after("create");
        return { id, tag: spec.tag };
      },
      async findByTag(tag: string, signal?: AbortSignal): Promise<LeaseRef[]> {
        await b.before("findByTag", signal);
        const found = [...b.sessions.values()].filter((s) => s.tag === tag && s.state === "running");
        b.record("findByTag", { tag, found: found.map((s) => s.id) });
        await b.after("findByTag");
        return found.map((s) => ({ id: s.id, tag: s.tag }));
      },
      async status(ref: LeaseRef, signal?: AbortSignal): Promise<ResourceStatus> {
        await b.before("status", signal);
        const s = b.sessions.get(ref.id);
        b.record("status", { id: ref.id });
        await b.after("status");
        return !s ? "gone" : s.state === "running" ? "running" : "stopped";
      },
      async attach(ref: LeaseRef, signal?: AbortSignal): Promise<AttachTarget> {
        await b.before("attach", signal);
        const s = b.sessions.get(ref.id);
        if (!s) throw new FakeProviderError(`no session ${ref.id}`, 404);
        b.record("attach", { id: ref.id });
        await b.after("attach");
        return b.targetOf(s);
      },
      async release(ref: LeaseRef, signal?: AbortSignal): Promise<void> {
        await b.before("release", signal);
        const s = b.sessions.get(ref.id);
        const was = s?.state === "running";
        if (s) s.state = "stopped";
        b.record(was ? "release" : "release-noop", { id: ref.id, tag: s?.tag ?? ref.tag });
        await b.after("release");
      },
      async liveView(ref: LeaseRef): Promise<LiveView | null> {
        const s = b.running(ref.id);
        b.record("liveView", { id: ref.id });
        if (!s) return null;
        const view = b.sentinels.bbLiveViewUrl;
        return { fullscreen: view, framed: `${view}&framed=1`, pages: [{ id: "p1", url: s.url, title: b.pages[s.url]?.title ?? "", fullscreen: view }] };
      },
      async fetch(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult> {
        await b.before("fetch", signal);
        b.record("fetch", { url: request.url });
        await b.after("fetch");
        const entry = b.opts.fetches[request.url];
        if (entry === undefined) throw new FakeProviderError(`fetch ${request.url}: 404`, 404);
        if (typeof entry === "string") return { finalUrl: request.url, statusCode: 200, contentType: "text/markdown", content: entry };
        const answer = entry[request.format === "raw" ? "raw" : "markdown"];
        if (!answer || "status" in answer) throw new FakeProviderError(`fetch ${request.url}: ${answer?.status ?? 404}`, answer?.status ?? 404);
        return { finalUrl: request.url, statusCode: 200, contentType: answer.contentType, content: answer.content };
      },
      async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
        await b.before("search", signal);
        b.record("search", { query: request.query });
        await b.after("search");
        return { results: b.opts.search.slice(0, request.n) };
      },
      downloads: {
        async list(_ref: LeaseRef): Promise<RemoteFile[]> { return Object.entries(b.opts.downloads).map(([name, body]) => ({ name, sizeBytes: Buffer.byteLength(body), modifiedAt: null })); },
        async read(_ref: LeaseRef, fileName: string, maxBytes: number): Promise<AsyncIterable<Uint8Array>> {
          const body = Buffer.from(b.opts.downloads[fileName] ?? "").subarray(0, maxBytes);
          return (async function* () { yield body; })();
        },
      },
    };
  }

  // ---- HTTP face -------------------------------------------------------------------------------------------------

  /**
   * Serve the backend over HTTP: `POST /rpc/<face>.<method>` with `{ args }`, answered `{ result }` or `{ error }`.
   * Run it in the parent; a child calls it through `remoteProvider` and `remoteDriver`, and a held call stays open
   * until the child dies.
   */
  async serve(): Promise<{ url: string; close(): Promise<void> }> {
    const faces: Record<string, Record<string, (...args: any[]) => unknown>> = {
      provider: this.provider as unknown as Record<string, (...args: any[]) => unknown>,
      broker: this.broker as unknown as Record<string, (...args: any[]) => unknown>,
      driver: this.driverFace as unknown as Record<string, (...args: any[]) => unknown>,
    };
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        const aborted = new AbortController();
        res.on("close", () => { if (!res.writableEnded) aborted.abort(); });
        try {
          const [face, method] = decodeURIComponent((req.url ?? "").replace(/^\/rpc\//, "")).split(".");
          const fn = faces[face ?? ""]?.[method ?? ""];
          if (typeof fn !== "function") { res.writeHead(404).end(JSON.stringify({ error: { message: `no ${face}.${method}`, status: 404 } })); return; }
          const args: unknown[] = raw ? (JSON.parse(raw) as { args: unknown[] }).args : [];
          const result = await (face === "provider" ? fn.call(faces[face], ...args, aborted.signal) : fn.call(faces[face], ...args));
          if (!res.writableEnded && !aborted.signal.aborted) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: result ?? null }));
        } catch (error) {
          if (aborted.signal.aborted) return;
          const e = error as { message?: string; status?: number };
          res.writeHead(e.status ?? 500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: e.message ?? String(error), status: e.status ?? 500 } }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    };
  }
}

/** The BrowserProvider a child process uses against `backend.serve()`. A held call never returns; an aborted one stops its request. */
export function remoteProvider(url: string, options: { name?: string; caps?: Partial<ProviderCaps> } = {}): BrowserProvider {
  const call = async (method: string, args: unknown[], signal?: AbortSignal): Promise<any> => {
    const res = await fetch(`${url}/rpc/provider.${method}`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string; status: number } };
    if (body.error) throw new FakeProviderError(body.error.message, body.error.status);
    return body.result;
  };
  return {
    name: options.name ?? "fake",
    caps: { ...DEFAULT_CAPS, ...options.caps },
    create: (spec, signal) => call("create", [spec], signal),
    findByTag: (tag, signal) => call("findByTag", [tag], signal),
    status: (ref, signal) => call("status", [ref], signal),
    attach: (ref, signal) => call("attach", [ref], signal),
    release: (ref, signal) => call("release", [ref], signal),
    liveView: (ref) => call("liveView", [ref]),
    fetch: (request, signal) => call("fetch", [request], signal),
    search: (request, signal) => call("search", [request], signal),
  };
}

/**
 * A host CredentialBroker over the backend. The broker counts a fill before the provider is touched and
 * never repeats an unknown one; its failures carry only codes, and with `echo` on, a hostile `message` besides, which
 * the package must not copy.
 */
export class FakeBroker {
  constructor(private readonly b: FakeBackend) {}

  async connections(): Promise<BrokerConnection[]> { return this.b.opts.connections; }

  async acquire(name: string): Promise<{ session: string; attach: AttachTarget; leaseExpiresAt: string; recording: boolean | null }> {
    await this.b.before("broker.acquire");
    const id = this.b.newId("br");
    const session: Session = { id, tag: name, metadata: {}, state: "running", url: this.b.opts.connections.find((c) => c.name === name)?.startUrl ?? this.b.opts.start, broker: true, plane: name };
    this.b.sessions.set(id, session);
    this.b.noteLive();
    this.b.record("broker.acquire", { id, name });
    await this.b.after("broker.acquire");
    return { session: id, attach: this.b.targetOf(session), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), recording: false };
  }

  async heartbeat(session: string): Promise<{ leaseExpiresAt: string }> {
    await this.b.before("broker.heartbeat");
    this.b.record("broker.heartbeat", { id: session });
    return { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  }

  async release(session: string): Promise<void> {
    await this.b.before("broker.release");
    const s = this.b.sessions.get(session);
    if (s) s.state = "stopped";
    this.b.record("broker.release", { id: session });
    await this.b.after("broker.release");
  }

  async fill(session: string, request: FillRequest): Promise<FillResult> {
    // Counted before the provider call: a fill cut here is `unknown` and is never repeated.
    this.b.record("broker.fill", { id: session, pageUrl: request.pageUrl, fields: request.fields.map((f) => f.field) });
    await this.b.before("broker.fill");
    await this.b.after("broker.fill");
    return { status: "completed", fields: request.fields.map((_f, index) => ({ index, status: "filled" })) };
  }

  async captureTotpSeed(session: string, request: { pageUrl: string; selector: string }): Promise<{ stored: boolean; field: string }> {
    this.b.record("broker.totp", { id: session, pageUrl: request.pageUrl });
    await this.b.before("broker.totp");
    return { stored: true, field: "otp" };
  }

  async downloads(): Promise<RemoteFile[]> { return Object.entries(this.b.opts.downloads).map(([name, body]) => ({ name, sizeBytes: Buffer.byteLength(body), modifiedAt: null })); }
}

/**
 * The driver's operations, keyed by the session id in the attach URL. Every op is recorded in `dispatched` (a read
 * answered from a receipt never shows up), takes the knobs (`delay`, `fail`, `echo`) as `driver.<op>`, and `hold`
 * applies it (the page moved, the row written) and never answers. Ops: connect, snapshot, run, url, screenshot, page, close.
 */
export class FakeDriverFace {
  constructor(private readonly b: FakeBackend) {}

  private session(id: string): Session {
    const s = this.b.sessions.get(id);
    if (!s || s.state !== "running") throw new FakeProviderError(`session ${id} is not running`, 410);
    return s;
  }

  private pageOf(id: string): FixturePage {
    const url = this.session(id).url;
    return this.b.pages[url] ?? fixturePage(url, "");
  }

  private async call(id: string, op: string, knob: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.b.before(`driver.${knob}`);
    this.b.dispatched.push({ op, session: id, url: this.b.sessions.get(id)?.url ?? null, ...detail });
  }

  /** Returns the session id the driver is bound to; the connect URL carries it. */
  async connect(target: AttachTarget): Promise<string> {
    await this.b.before("driver.connect");
    const id = new URL(target.sdkCdpUrl).searchParams.get("sessionId") ?? "";
    this.session(id);
    return id;
  }

  async snapshot(id: string): Promise<string> {
    await this.call(id, "snapshot", "snapshot");
    const out = `[0] main\n  [1] text: ${this.pageOf(id).text}`;
    await this.b.after("driver.snapshot");
    return out;
  }

  /** A `goto` action moves the page; any other code returns what it was given. */
  async run(id: string, input: { code?: string; actions?: Array<{ op: string; url?: string; [field: string]: unknown }> }): Promise<unknown> {
    await this.call(id, "run", "run", { input });
    const go = input.actions?.find((action) => action.op === "goto");
    if (go?.url) this.session(id).url = go.url;
    const out = input.actions ? { completed: input.actions.length, url: this.session(id).url } : { value: input.code };
    await this.b.after("driver.run");
    return out;
  }

  /** The page's URL; no dispatched row, since a read of the URL is not a read of the page. */
  async url(id: string): Promise<string> {
    await this.b.before("driver.url");
    return this.session(id).url;
  }

  /** An image whose header decodes to the viewport (or the full page) times the device scale; each capture is a
   *  dispatched row carrying its options, so a test can read the retake ladder. */
  async screenshot(id: string, options: FakeScreenshotOptions = {}): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    await this.call(id, "screenshot", "screenshot", { options });
    const { viewport = { width: 1288, height: 711 }, fullPageHeight = 8319, deviceScale = 1 } = this.b.opts;
    const factor = options.scale === "css" ? 1 : deviceScale;
    const width = viewport.width * factor;
    const height = (options.fullPage ? fullPageHeight : viewport.height) * factor;
    const type = options.type ?? "jpeg";
    await this.b.after("driver.screenshot");
    return { data: fakeImage(type, width, height).toString("base64"), mimeType: `image/${type}`, width, height };
  }

  async page(id: string): Promise<FixturePage> {
    await this.call(id, "read", "page");
    const out = { ...this.pageOf(id) };
    await this.b.after("driver.page");
    return out;
  }

  async close(id: string): Promise<void> {
    this.b.dispatched.push({ op: "close", session: id, url: null });
  }
}
