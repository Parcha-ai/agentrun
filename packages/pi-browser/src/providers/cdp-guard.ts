// A guard on a local Chrome's DevTools socket: a relay every client of the session reaches the browser through (the
// driver, Stagehand's extension in the browser, and so the code a model runs there), which reads each command and refuses
// the ones that would make the browser read or write this machine's files or open a page that is not on the web. The
// browser's own socket stays on a port no page and no extension can reach (the host's network fence), so this relay is the
// one way in for anything inside the browser; the host's own code (the provider) uses the socket directly.
//
// What it passes (cdpRefusal): an allowlist, ALLOWED_METHODS, of the commands pi-browser's driver, its effect observer
// and live view, and Stagehand (in Node and in its extension) send, measured across pi-browser's real-Chrome suites and
// serve's with the guard on, and named in their sources. Every other command is refused: among them each one that tells
// of the machine the browser runs on (SystemInfo.*, Browser.getBrowserCommandLine, its processes), an attach to the
// browser's own target, Extensions.*, PWA.*, Tethering.*, Cast.*, Target.exposeDevToolsProtocol, setRemoteLocations,
// openDevTools, Browser.executeBrowserCommand and DOM.setFileInputFiles. Of the commands it passes, these are held to
// what they may name:
//  - a navigation or a new target to anything but http, https or about:blank (and the extension's own pages, which the
//    driver opens to wake its worker): file:, chrome:, devtools:, view-source:, filesystem:, blob:, data:, javascript: and
//    every other scheme (Page.navigate, Target.createTarget);
//  - a request rewritten or fetched by the browser to such a URL (Fetch.continueRequest's url, Network.loadNetworkResource);
//  - a file of this machine handed to a page (a drag's files, Page.handleFileChooser's files);
//  - downloads sent to a directory the command names (Browser/Page.setDownloadBehavior with downloadPath);
//  - each of these inside Target.sendMessageToTarget's message as well.
// A page's own navigation to such a scheme (a link, location.href, window.open from an http page) is Chrome's to refuse,
// and it does: "Not allowed to load local resource". An extension's page is not held to that rule (it may move itself,
// or open a tab, on a file), so no client may drive one: attaching to a target, and every command on a session, is
// refused unless the target is a web page (http, https, about:blank, about:srcdoc, or Chrome's error page for one) or a
// worker. The guard keeps its own view of every target (allowedTarget), and closes at once any page it sees on a file or
// a browser-internal URL.
//
// The relay passes the handshake to the browser unchanged but for compression, which it takes out so every message can
// be read; the browser checks the Origin as it always does. A request that is not a WebSocket upgrade to /devtools/ is
// refused, so a page cannot read the browser's /json lists through it either. A refused command is answered as the
// browser answers an error, in words that name no path.
import { connect, createServer, type AddressInfo, type Socket } from "node:net";

/** Where the guard listens, and the browser's socket it relays to: this machine's loopback. */
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the guard and the browser socket it relays to listen on loopback alone
/** Each domain's commands a guarded session passes: the ones pi-browser and Stagehand send (their sources, and what
 *  pi-browser's and serve's real-Chrome suites sent through the guard, which named none outside them). */
const ALLOWED_BY_DOMAIN: Readonly<Record<string, readonly string[]>> = {
  Accessibility: ["enable", "getFullAXTree"],
  Browser: ["cancelDownload", "close", "grantPermissions", "setDownloadBehavior"],
  DOM: ["describeNode", "enable", "getBoxModel", "getDocument", "getFrameOwner", "getNodeForLocation", "querySelector", "requestNode", "scrollIntoViewIfNeeded"],
  DOMStorage: ["enable", "getDOMStorageItems", "setDOMStorageItem"],
  Emulation: ["setDefaultBackgroundColorOverride", "setDeviceMetricsOverride", "setVisibleSize"],
  Fetch: ["continueRequest", "disable", "enable", "failRequest", "fulfillRequest"],
  Input: ["dispatchDragEvent", "dispatchKeyEvent", "dispatchMouseEvent", "insertText"],
  Network: ["enable", "getResponseBody", "loadNetworkResource", "setExtraHTTPHeaders"],
  Overlay: ["enable", "hideHighlight", "highlightNode"],
  Page: ["addScriptToEvaluateOnNewDocument", "bringToFront", "captureScreenshot", "createIsolatedWorld", "enable", "getFrameTree", "getLayoutMetrics", "getNavigationHistory", "handleFileChooser", "handleJavaScriptDialog", "navigate", "navigateToHistoryEntry", "reload", "screencastFrameAck", "setDownloadBehavior", "setLifecycleEventsEnabled", "startScreencast", "stopScreencast"],
  Runtime: ["addBinding", "callFunctionOn", "enable", "evaluate", "releaseObject", "runIfWaitingForDebugger"],
  Storage: ["clearCookies", "getCookies", "setCookies"],
  Target: ["activateTarget", "attachToTarget", "closeTarget", "createTarget", "detachFromTarget", "getTargetInfo", "getTargets", "sendMessageToTarget", "setAutoAttach", "setDiscoverTargets"],
};
const ALLOWED_LIST = Object.entries(ALLOWED_BY_DOMAIN).flatMap(([domain, methods]) => methods.map((method) => `${domain}.${method}`));
/** What a refused command is told. */
export const GUARD_REFUSAL = "Refused: this browser opens web pages only (http, https and about:blank), and answers nothing about the server it runs on. Files on the server, browser-internal pages and other local schemes cannot be opened, uploaded from or downloaded to, from a page or from code.";

/** The commands a guarded session passes, and no other (cdpRefusal holds some of them to what they name). */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set(ALLOWED_LIST);

/** Whether `url` is a page this browser may open: http, https, about:blank, or a page of the extension `extension` (an
 *  origin, chrome-extension://<id>) when one is given. Empty is about:blank. */
export function allowedUrl(url: unknown, extension: string | null = null): boolean {
  if (url === undefined || url === "") return true;
  if (typeof url !== "string") return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return true;
  if (parsed.protocol === "about:") return parsed.pathname === "blank";
  // A chrome-extension URL has no origin to a URL parser (not a special scheme): its host is the extension's id.
  return extension !== null && parsed.protocol === "chrome-extension:" && `chrome-extension://${parsed.host}` === extension;
}

/** Why the DevTools command `message` (method and params) is refused, or null when it may pass. `extension`: the
 *  driver's own extension origin, whose pages may be opened. */
export function cdpRefusal(message: { method?: unknown; params?: unknown }, extension: string | null = null): string | null {
  const method = typeof message.method === "string" ? message.method : "";
  const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as Record<string, any>;
  if (!ALLOWED_METHODS.has(method)) return GUARD_REFUSAL;
  switch (method) {
    case "Page.navigate":
    case "Target.createTarget":
      return allowedUrl(params.url, extension) ? null : GUARD_REFUSAL;
    case "Network.loadNetworkResource":
      return allowedUrl(params.url) && !/^about:/i.test(String(params.url ?? "")) ? null : GUARD_REFUSAL;
    case "Fetch.continueRequest":
      return params.url === undefined || (allowedUrl(params.url) && !/^about:/i.test(String(params.url))) ? null : GUARD_REFUSAL;
    case "Input.dispatchDragEvent":
      return Array.isArray(params.data?.files) && params.data.files.length > 0 ? GUARD_REFUSAL : null;
    case "Page.handleFileChooser":
      return Array.isArray(params.files) && params.files.length > 0 ? GUARD_REFUSAL : null;
    case "Browser.setDownloadBehavior":
    case "Page.setDownloadBehavior":
      return params.downloadPath === undefined ? null : GUARD_REFUSAL;
    case "Target.sendMessageToTarget": {
      let inner: unknown;
      try { inner = JSON.parse(String(params.message)); } catch { return GUARD_REFUSAL; }
      return typeof inner === "object" && inner !== null ? cdpRefusal(inner as { method?: unknown; params?: unknown }, extension) : GUARD_REFUSAL;
    }
    default:
      return null;
  }
}

type Frame = { fin: boolean; rsv: number; opcode: number; payload: Buffer; raw: Buffer };

/** The next whole frame at the start of `buffer`, or null until it has arrived. */
function frameAt(buffer: Buffer): Frame | null {
  if (buffer.length < 2) return null;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let at = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); at = 4; }
  else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame too large");
    length = Number(big); at = 10;
  }
  const mask = masked ? (buffer.length < at + 4 ? null : buffer.subarray(at, at + 4)) : undefined;
  if (mask === null) return null;
  if (masked) at += 4;
  if (buffer.length < at + length) return null;
  const payload = Buffer.from(buffer.subarray(at, at + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
  return { fin: (buffer[0]! & 0x80) !== 0, rsv: buffer[0]! & 0x70, opcode: buffer[0]! & 0x0f, payload, raw: buffer.subarray(0, at + length) };
}

/** An unmasked text frame, as a server sends one. */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : payload.length < 65_536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b; })()]);
  return Buffer.concat([head, payload]);
}

const HEADERS_END = Buffer.from("\r\n\r\n");

/** What the guard knows of a target. */
export type TargetInfo = { targetId: string; type: string; url: string };
/** What a client may still send on a session to a target it may not drive. */
const UNDRIVEN = new Set(["Runtime.runIfWaitingForDebugger", "Target.detachFromTarget"]);
/** Workers run no page of their own; the browser's own session has no target. */
const WORKER_TYPES = new Set(["service_worker", "shared_worker", "worker", "browser"]);

/** Whether a client may attach to, or drive, the target `info`: a worker, or a page on the web (http, https,
 *  about:blank, about:srcdoc, or Chrome's error page for a page that did not load). Never an extension's page, which
 *  may move itself onto a file, nor a page on a file or a browser-internal URL. */
export function allowedTarget(info: TargetInfo | undefined): boolean {
  if (!info) return false;
  if (WORKER_TYPES.has(info.type)) return true;
  return allowedUrl(info.url) || info.url === "about:srcdoc" || info.url.startsWith("chrome-error://");
}

/** A page on a URL no page of this browser may show, which the guard closes as soon as it sees it. */
const closable = (info: TargetInfo): boolean => !WORKER_TYPES.has(info.type) && /^(file|chrome|chrome-untrusted|devtools|view-source|filesystem):/i.test(info.url);

/** The guard's own view of the browser's targets, on its own connection to the browser's socket: each target as it is
 *  made and moved, a page on a file or browser-internal URL closed at once, and any target asked about looked up. */
class Targets {
  private readonly known = new Map<string, TargetInfo>();
  private socket: Promise<{ call(method: string, params?: object): Promise<any> }> | null = null;
  private open: WebSocket | null = null;
  constructor(private readonly port: number, private readonly host: string) {}

  private connection() {
    return (this.socket ??= (async () => {
      const version = await (await fetch(`http://${this.host}:${this.port}/json/version`, { signal: AbortSignal.timeout(5_000) })).json() as { webSocketDebuggerUrl: string };
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      this.open = socket;
      await new Promise<void>((ok, fail) => { socket.onopen = () => ok(); socket.onerror = () => fail(new Error("the guard could not reach the browser")); });
      let next = 0;
      const waiting = new Map<number, (message: any) => void>();
      socket.onerror = null;
      socket.onclose = () => { for (const done of waiting.values()) done({ error: { message: "closed" } }); waiting.clear(); this.socket = null; };
      socket.onmessage = (event) => {
        let message: any;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (typeof message.id === "number") { waiting.get(message.id)?.(message); waiting.delete(message.id); return; }
        if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") this.note(message.params?.targetInfo);
        if (message.method === "Target.targetDestroyed") this.known.delete(message.params?.targetId);
      };
      const call = (method: string, params: object = {}) => new Promise<any>((done) => { const id = ++next; waiting.set(id, done); socket.send(JSON.stringify({ id, method, params })); });
      await call("Target.setDiscoverTargets", { discover: true });
      return { call };
    })().catch((error: unknown) => { this.socket = null; throw error; }));
  }

  /** Learns a target's place, and closes it when it is a page no page may be. */
  note(info: TargetInfo | undefined): void {
    if (!info?.targetId) return;
    this.known.set(info.targetId, info);
    if (closable(info)) void this.connection().then((browser) => browser.call("Target.closeTarget", { targetId: info.targetId })).catch(() => undefined);
  }

  /** The target `targetId` as the browser has it now: from its events, else asked. */
  async info(targetId: unknown): Promise<TargetInfo | undefined> {
    if (typeof targetId !== "string") return undefined;
    const known = this.known.get(targetId);
    if (known) return known;
    const answer = await this.connection().then((browser) => browser.call("Target.getTargetInfo", { targetId })).catch(() => undefined);
    const info = answer?.result?.targetInfo as TargetInfo | undefined;
    if (info) this.note(info);
    return info;
  }

  start(): void { void this.connection().catch(() => undefined); }
  close(): void { this.open?.close(); this.open = null; this.socket = null; }
}

/** One client's connection through the guard: its handshake, then each message it sends read and passed or refused, in
 *  the order it sent them. */
function relay(client: Socket, upstreamPort: number, upstreamHost: string, extension: () => string | null, targets: Targets, onRefused: (method: string) => void): void {
  const upstream = connect({ host: upstreamHost, port: upstreamPort });
  const end = () => { client.destroy(); upstream.destroy(); };
  client.on("error", end); upstream.on("error", end); client.on("close", end); upstream.on("close", end);
  let fromClient = Buffer.alloc(0);
  let fromBrowser = Buffer.alloc(0);
  let clientOpen = false; // the handshake has passed
  let browserOpen = false; // the browser has answered it 101
  let message: Frame[] = []; // the client's message being assembled from its fragments
  let browserMessage: Frame[] = []; // the browser's, likewise
  const pending: Buffer[] = []; // refusals to tell the client at the next message boundary of the browser's stream
  const flushPending = () => { if (browserMessage.length === 0) while (pending.length) client.write(pending.shift()!); };
  /** This connection's sessions, each to the target it drives ("browser" for the browser's own). */
  const sessions = new Map<string, string>();
  /** The attaches sent and not yet answered: their session and id, to the target each names. */
  const attaching = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();

  /** Whether `command` may pass: the method rule, then the target it names or drives. */
  const allowed = async (command: { id?: unknown; sessionId?: unknown; method?: unknown; params?: any }): Promise<boolean> => {
    if (cdpRefusal(command, extension())) return false;
    if (command.sessionId !== undefined) {
      const target = sessions.get(String(command.sessionId));
      if (target === undefined) return false;
      // On a target no client may drive, only what lets it go on as it would without one: run on from a pause, or let go.
      if (target !== "browser" && !allowedTarget(await targets.info(target)) && !UNDRIVEN.has(String(command.method))) return false;
    }
    if (command.method === "Target.attachToTarget") {
      if (!allowedTarget(await targets.info(command.params?.targetId))) return false;
      attaching.set(`${String(command.sessionId ?? "")}|${String(command.id)}`, String(command.params.targetId));
    }
    if (command.method === "Target.attachToBrowserTarget") attaching.set(`${String(command.sessionId ?? "")}|${String(command.id)}`, "browser");
    return true;
  };

  const refuse = (command: { id?: unknown; sessionId?: unknown; method?: unknown }) => {
    onRefused(String(command.method));
    pending.push(textFrame(JSON.stringify({ id: command.id, ...(command.sessionId !== undefined ? { sessionId: command.sessionId } : {}), error: { code: -32000, message: GUARD_REFUSAL } })));
    flushPending();
  };

  client.on("data", (chunk: Buffer) => {
    fromClient = Buffer.concat([fromClient, chunk]);
    if (!clientOpen) {
      const endsAt = fromClient.indexOf(HEADERS_END);
      if (endsAt < 0) { if (fromClient.length > 16_384) end(); return; }
      const head = fromClient.subarray(0, endsAt).toString("latin1");
      const [requestLine, ...lines] = head.split("\r\n");
      const upgrade = lines.some((line) => /^upgrade:\s*websocket\s*$/i.test(line));
      if (!/^GET \/devtools\/\S* HTTP\/1\.1$/.test(requestLine ?? "") || !upgrade) {
        client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        upstream.destroy();
        return;
      }
      // No compression: every message must be read as it is.
      const kept = lines.filter((line) => !/^sec-websocket-extensions:/i.test(line));
      upstream.write(`${[requestLine, ...kept].join("\r\n")}\r\n\r\n`);
      fromClient = fromClient.subarray(endsAt + HEADERS_END.length);
      clientOpen = true;
      targets.start();
    }
    for (;;) {
      let frame: Frame | null;
      try { frame = frameAt(fromClient); } catch { return end(); }
      if (!frame) return;
      fromClient = fromClient.subarray(frame.raw.length);
      if (frame.rsv !== 0) return end();
      // Control frames pass in their turn, after the messages before them.
      if (frame.opcode >= 0x8) { const raw = Buffer.from(frame.raw); queue = queue.then(() => void upstream.write(raw)); continue; }
      if (frame.opcode === 0x2 || (frame.opcode === 0x0 && message.length === 0)) return end();
      message.push({ ...frame, raw: Buffer.from(frame.raw) });
      if (!frame.fin) continue;
      const frames = message;
      message = [];
      queue = queue.then(async () => {
        let command: { id?: unknown; sessionId?: unknown; method?: unknown; params?: unknown } | null = null;
        try { command = JSON.parse(Buffer.concat(frames.map((f) => f.payload)).toString("utf8")); } catch { /* not a command: the browser answers it */ }
        if (command && typeof command === "object" && !(await allowed(command).catch(() => false))) return refuse(command);
        for (const f of frames) upstream.write(f.raw);
      }).catch(() => end());
    }
  });

  /** What the browser tells this client of its sessions: each one opened, to its target, and each one closed. */
  const learn = (payload: Buffer) => {
    if (payload.length > 65_536) return;
    const text = payload.toString("utf8");
    if (attaching.size === 0 && !text.includes("Target.attachedToTarget") && !text.includes("Target.detachedFromTarget")) return;
    let event: any;
    try { event = JSON.parse(text); } catch { return; }
    const key = `${String(event.sessionId ?? "")}|${String(event.id)}`;
    if (event.id !== undefined && attaching.has(key)) {
      if (typeof event.result?.sessionId === "string") sessions.set(event.result.sessionId, attaching.get(key)!);
      attaching.delete(key);
    }
    if (event.method === "Target.attachedToTarget" && typeof event.params?.sessionId === "string") {
      sessions.set(event.params.sessionId, String(event.params.targetInfo?.targetId));
      targets.note(event.params.targetInfo);
    }
    if (event.method === "Target.detachedFromTarget" && typeof event.params?.sessionId === "string") sessions.delete(event.params.sessionId);
  };

  upstream.on("data", (chunk: Buffer) => {
    fromBrowser = Buffer.concat([fromBrowser, chunk]);
    if (!browserOpen) {
      const endsAt = fromBrowser.indexOf(HEADERS_END);
      if (endsAt < 0) return;
      const head = fromBrowser.subarray(0, endsAt + HEADERS_END.length);
      client.write(head);
      fromBrowser = fromBrowser.subarray(head.length);
      if (!/^HTTP\/1\.1 101 /.test(head.toString("latin1"))) { client.end(); upstream.destroy(); return; }
      browserOpen = true;
    }
    for (;;) {
      let frame: Frame | null;
      try { frame = frameAt(fromBrowser); } catch { return end(); }
      if (!frame) return;
      fromBrowser = fromBrowser.subarray(frame.raw.length);
      if (frame.opcode < 0x8) {
        browserMessage.push({ ...frame, raw: Buffer.from(frame.raw) });
        if (!frame.fin) continue;
        // A whole message: what it says of sessions is learned before the client reads it.
        const frames = browserMessage;
        browserMessage = [];
        if (frames[0]!.opcode === 0x1) learn(Buffer.concat(frames.map((f) => f.payload)));
        for (const f of frames) client.write(f.raw);
      } else client.write(Buffer.from(frame.raw));
      flushPending();
    }
  });
}

/** The guard for a browser whose DevTools socket listens on loopback port `upstreamPort`: a relay on a loopback port of
 *  its own (`port`). `extension`: the driver's extension origin, read at each command (it is known once its copy is
 *  made). `onRefused`: told the method of each command refused. */
export async function startCdpGuard(options: { upstreamPort: number; upstreamHost?: string; extension?: () => string | null; onRefused?: (method: string) => void; host?: string }): Promise<{ port: number; close(): Promise<void> }> {
  const host = options.host ?? LOOPBACK;
  const upstreamHost = options.upstreamHost ?? host;
  const targets = new Targets(options.upstreamPort, upstreamHost);
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    relay(client, options.upstreamPort, upstreamHost, options.extension ?? (() => null), targets, options.onRefused ?? (() => {}));
  });
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(0, host, () => ok()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((ok) => { targets.close(); server.close(() => ok()); for (const socket of sockets) socket.destroy(); }),
  };
}
