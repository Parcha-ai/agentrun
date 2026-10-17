import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { drivingGates } from "../core/driving.js";
import type { LiveView } from "../core/host.js";
import { CLOSE_CODES, encodeFrame, LIMITS, parseClientMessage, type ClientMessage, type DrivingGate, type DrivingGates, type ServerMessage, type Stream, type StreamFactory, type ViewerAssets } from "./protocol.js";
import { openStream } from "./stream.js";
import { newToken, newViewerId, tokenMatches } from "./token.js";
import { viewerAssets } from "./viewer.js";
import { acceptWebSocket, type WsConn } from "./ws.js";

export type LiveViewOptions = {
  /** The one origin allowed to frame the viewer (`frame-ancestors`). Null: none. Required, so the choice is never a default. */
  hostOrigin: string | null;
  /** Where the host mounts `handle` and `upgrade`, e.g. `https://host.example/live`. Its origin is the viewer's own origin, which an upgrade's Origin
   *  header must equal. Absent: the live view starts its own server on 127.0.0.1 (never 0.0.0.0), on an ephemeral port, at the first `open`. */
  baseUrl?: string;
  /** The screencast and input (stream.ts); the default is the package's own. A test passes a fake. */
  stream?: StreamFactory;
  /** The person/model mutex. Absent, the package's own process-wide registry (`drivingGates`, core/driving.ts), the one the toolset's model calls use, so a
   *  host passes nothing and person and model still never interleave. An override must be the SAME registry the toolset is given (`gates` on
   *  `createBrowserExtension`), or the two sides do not see each other:
   *  ```ts
   *  const gates = createDrivingGates({ idleMs: 5_000 });
   *  createLiveView({ hostOrigin, gates });
   *  createBrowserExtension({ ..., gates });
   *  ``` */
  gates?: DrivingGates;
  /** The viewer page (viewer.ts); the default is the package's own. */
  viewer?: ViewerAssets;
  /** How long a connection may stay silent before its hello, and how many may wait for one. */
  helloTimeoutMs?: number;
  maxPending?: number;
};

export type LiveViewHost = {
  /** Serves the viewer page and its two static files; true when the request was this host's (mounted at `baseUrl`'s path), false when it was not. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** Takes a WebSocket upgrade for a viewer; true when the request was this host's. A bad Origin or an unknown path id is refused here. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** The viewer's URL for one session, with its token in the fragment. Idempotent per tag: the same URL until `release`. Only the host's `onSession`
   *  ever receives it. Nothing starts until a viewer authenticates. */
  open(tag: string, cdpUrl: string): Promise<LiveView>;
  /** The view `open` gave for a tag, or null: for a caller that must not start anything (`liveViewProvider` asks before it attaches). */
  known(tag: string): LiveView | null;
  /** True while a person is driving this session (viewer input within the gate's idle window): the frame recorder holds its capture meanwhile. */
  driving(tag: string): boolean;
  /** The token is dead, the viewer's socket closed, the stream and the gate ended. Idempotent. */
  release(tag: string): Promise<void>;
  /** What the host holds, for diagnostics and tests: the sessions with a viewer URL and the opens in flight. Neither grows with the sessions it once released. */
  tracked(): { sessions: number; opening: number };
  /** Releases every session and stops the server it started, if any. */
  close(): Promise<void>;
};

const ID = /^[A-Za-z0-9_-]{22}$/;
/** A viewer that cannot take frames as fast as they come drops them: past this many unsent bytes a frame is acknowledged unsent. */
const SLOW_VIEWER_BYTES = 512 * 1024;
/** Input messages are tiny: a whole message, fragments included, over this ends the connection (1009). */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** A viewer whose messages the protocol does not know: one is dropped with a notice, and past this many within the window the connection is closed. */
/** While a person's command runs, their driving turn is renewed this often (the gate's window is 3 s by default). */
const KEEP_DRIVING_MS = 1_000;
/** Messages a viewer may have waiting behind the browser command that is running; the rest are dropped with `held busy`, and a viewer that keeps doing it is closed. */
const MAX_QUEUED_INPUT = 32;
const MAX_BAD_MESSAGES = 20;
const BAD_WINDOW_MS = 10_000;

/** A message waiting its turn behind the browser command that is running: `message` is replaced while it waits when a later message of the same kind supersedes it. */
type Queued = { message: Exclude<ClientMessage, { type: "hello" }>; started: boolean };
type Viewer = { conn: WsConn; stream: Stream; gate: DrivingGate; unsubscribe: () => void; chain: Promise<void>; bad: number[]; queued: number; tail: Queued | null };
type Entry = { tag: string; id: string; token: string; cdpUrl: string; view: LiveView | null; released: boolean; viewer: Viewer | null; pending: Set<WsConn> };

export function createLiveView(options: LiveViewOptions): LiveViewHost {
  const helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
  const maxPending = options.maxPending ?? 8;
  const byTag = new Map<string, Entry>();
  const byId = new Map<string, Entry>();
  const mounted = options.baseUrl ? new URL(options.baseUrl) : null;
  let origin = mounted?.origin ?? null;
  const prefix = mounted ? mounted.pathname.replace(/\/+$/, "") : "";
  let server: Server | null = null;
  let starting: Promise<void> | null = null;
  let closed = false;
  /** The opens waiting for the server, by tag: a `release` or a `close` that comes meanwhile marks them cancelled, and each open takes its own mark off when it ends, so
   *  nothing is kept for a tag that has no open in flight. */
  const opening = new Map<string, Set<{ cancelled: boolean }>>();

  const need = <T>(value: T | undefined, what: string): T => { if (value === undefined) throw new Error(`the live view has no ${what}`); return value; };
  const send = (conn: WsConn, message: ServerMessage): void => { conn.send(JSON.stringify(message)); };
  const refuse = (conn: WsConn, reason: "unauthorized" | "viewer_in_use" | "released" | "bad_message"): void => { send(conn, { type: "refused", reason }); conn.close(CLOSE_CODES[reason], reason); };

  /** The request's path, or null when its target cannot be read as one (`//[`): such a request is nobody's, so it is not this host's and nothing is thrown into the
   *  listener of the server that mounts it. */
  const pathOf = (req: IncomingMessage): string | null => { try { return new URL(req.url ?? "/", "http://placeholder").pathname; } catch { return null; } };

  /** The path after the mount, or null when the request is not under it ("/mount/liveness" is not under "/mount/live"). */
  const relative = (pathname: string): string | null => {
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    return rest.startsWith("/") ? rest : null;
  };
  const wsOrigin = (): string => (origin ?? "").replace(/^http/, "ws");
  const securityHeaders = (): Record<string, string> => ({
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ${wsOrigin()}; base-uri 'none'; form-action 'none'; frame-ancestors ${options.hostOrigin ?? "'none'"}`,
  });

  const handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = pathOf(req);
    const rel = path === null ? null : relative(path);
    if (rel === null) return false;
    const page = /^\/v\/([^/]+)$/.exec(rel);
    const upgradeRoute = /^\/v\/([^/]+)\/ws$/.exec(rel);
    if (!page && !upgradeRoute && rel !== "/viewer.js" && rel !== "/viewer.css") return false;
    const reply = (status: number, type: string, body: string): true => { res.writeHead(status, { ...securityHeaders(), "Content-Type": type, "Content-Length": Buffer.byteLength(body) }); res.end(req.method === "HEAD" ? undefined : body); return true; };
    if (req.method !== "GET" && req.method !== "HEAD") return reply(405, "text/plain", "method not allowed");
    if (upgradeRoute) return reply(426, "text/plain", "upgrade required");
    const viewer = options.viewer ?? viewerAssets;
    if (rel === "/viewer.js") return reply(200, "text/javascript; charset=utf-8", viewer.js);
    if (rel === "/viewer.css") return reply(200, "text/css; charset=utf-8", viewer.css);
    const entry = ID.test(page![1]!) ? byId.get(page![1]!) : undefined;
    if (!entry || entry.released) return reply(404, "text/plain", "not found");
    return reply(200, "text/html; charset=utf-8", viewer.html);
  };

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const path = pathOf(req);
    const rel = path === null ? null : relative(path);
    const match = rel === null ? null : /^\/v\/([^/]+)\/ws$/.exec(rel);
    if (!match) return false;
    const deny = (status: string): true => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return true; };
    // A browser always sends its page's origin on a WebSocket; another tab's script cannot forge it. Anything but the viewer's own is refused.
    if (origin === null || req.headers.origin !== origin) return deny("403 Forbidden");
    const entry = ID.test(match[1]!) ? byId.get(match[1]!) : undefined;
    if (!entry || entry.released) return deny("404 Not Found");
    if (entry.pending.size >= maxPending) return deny("503 Service Unavailable");
    const conn = acceptWebSocket(req, socket, head, { maxPayload: MAX_MESSAGE_BYTES });
    if (!conn) return true;
    entry.pending.add(conn);
    // The slot is freed when the connection is cut off, not when its socket finishes closing: a viewer arriving at that moment must not be counted out.
    const timer = setTimeout(() => { if (entry.pending.delete(conn)) refuse(conn, "unauthorized"); }, helloTimeoutMs);
    timer.unref();
    conn.onClose = () => { clearTimeout(timer); entry.pending.delete(conn); if (entry.viewer?.conn === conn) endViewer(entry); };
    conn.onMessage = (data, binary) => {
      if (entry.viewer?.conn === conn) { onViewerMessage(entry, entry.viewer, data, binary); return; }
      if (!entry.pending.has(conn)) return;
      clearTimeout(timer);
      onHello(entry, conn, data, binary);
    };
    return true;
  };

  /** The first message of a connection, and the only one that is read before the token is proven. */
  const onHello = (entry: Entry, conn: WsConn, data: string | Buffer, binary: boolean): void => {
    entry.pending.delete(conn);
    const message: ClientMessage | null = binary || typeof data !== "string" ? null : parseClientMessage(data);
    if (message?.type !== "hello" || !tokenMatches(entry.token, message.token) || entry.released) return refuse(conn, "unauthorized");
    // One authenticated viewer per session, told so, and the first is never replaced.
    if (entry.viewer) return refuse(conn, "viewer_in_use");
    let viewer: Viewer;
    try {
      const gate = (options.gates ?? drivingGates)(entry.tag);
      const stream = (options.stream ?? openStream)(entry.cdpUrl, {
        frame(jpeg, page, ack) {
          if (conn.closed || conn.buffered > SLOW_VIEWER_BYTES) { ack(); return; }
          if (!conn.send(encodeFrame(jpeg, page.w, page.h), ack)) ack();
        },
        page: (page) => send(conn, { type: "page", url: page.url, title: page.title }),
        dialog: (dialog) => send(conn, dialog ? { type: "dialog", ...dialog } : { type: "dialog_closed" }),
        closed: () => { if (entry.viewer?.conn === conn) { send(conn, { type: "ended", reason: "browser_closed" }); conn.close(CLOSE_CODES.browser_closed, "browser_closed"); } },
      });
      viewer = { conn, stream, gate, unsubscribe: gate.onChange((drive) => send(conn, { type: "status", drive })), chain: Promise.resolve(), bad: [], queued: 0, tail: null };
    } catch { conn.close(1011, "unavailable"); return; }
    entry.viewer = viewer;
    // A person who sits still with the viewer open is still using the session: custody does not release it on its own while this is set.
    viewer.gate.setViewing(true);
    send(conn, { type: "ready", drive: viewer.gate.state() });
  };

  const onViewerMessage = (entry: Entry, viewer: Viewer, data: string | Buffer, binary: boolean): void => {
    const message = binary || typeof data !== "string" ? null : parseClientMessage(data);
    // A message the protocol does not know, and one dropped because too many are waiting, are the same kind of excess: a viewer that keeps sending either is closed.
    const excess = (reason: "bad_message" | "busy"): void => {
      const now = Date.now();
      viewer.bad = [...viewer.bad.filter((at) => now - at < BAD_WINDOW_MS), now];
      if (viewer.bad.length > MAX_BAD_MESSAGES) { refuse(viewer.conn, "bad_message"); return; }
      send(viewer.conn, { type: "held", reason });
    };
    if (!message || message.type === "hello") { excess("bad_message"); return; }
    // While a model call is in flight the input is dropped, not queued: a keystroke replayed after the model moved the page is worse than a lost one.
    if (viewer.gate.input() === "agent_acting") { send(viewer.conn, { type: "held", reason: "agent_acting" }); return; }
    // Mouse moves and scrolls arrive once per animation frame, so a slow browser command is always followed by a run of them. A run is combined into its last waiting
    // message (the latest position; the scroll summed) instead of queued one by one: nothing grows, order against presses and keys is kept (only the LAST waiting
    // message is ever merged into), and ordinary dragging is never counted as abuse.
    const waiting = viewer.tail;
    if (waiting && !waiting.started && message.type === "mouse" && message.action === "move" && waiting.message.type === "mouse" && waiting.message.action === "move") { waiting.message = message; return; }
    // Scrolls are summed only when they were made at the same point with the same modifiers: two scrolls over different controls (or one with Control held, a zoom) are two.
    if (waiting && !waiting.started && message.type === "wheel" && waiting.message.type === "wheel" && waiting.message.x === message.x && waiting.message.y === message.y && (waiting.message.modifiers ?? 0) === (message.modifiers ?? 0)) {
      const clamp = (n: number): number => Math.max(-LIMITS.wheel, Math.min(LIMITS.wheel, n));
      waiting.message = { ...message, deltaX: clamp(waiting.message.deltaX + message.deltaX), deltaY: clamp(waiting.message.deltaY + message.deltaY) };
      return;
    }
    if (viewer.queued >= MAX_QUEUED_INPUT) {
      // A move that does not fit is superseded by the next one a frame later: dropping it is not misbehaviour.
      if (message.type === "mouse" && message.action === "move") return;
      excess("busy");
      return;
    }
    const item: Queued = { message, started: false };
    viewer.tail = item;
    viewer.queued += 1;
    viewer.chain = viewer.chain.then(async () => {
      item.started = true;
      if (viewer.tail === item) viewer.tail = null;
      const message = item.message;
      if (entry.viewer !== viewer) { viewer.queued -= 1; return; }
      // Messages wait their turn behind a slow command, so the gate is asked again at delivery: the model may have taken the browser since the message arrived.
      if (viewer.gate.input() === "agent_acting") { send(viewer.conn, { type: "held", reason: "agent_acting" }); viewer.queued -= 1; return; }
      // The person's turn must not lapse while their own command runs (a navigation can take seconds, the window is 3 s): it is renewed until the command returns.
      const keep = setInterval(() => { viewer.gate.input(); }, KEEP_DRIVING_MS);
      keep.unref();
      try {
        if (message.type === "nav") await viewer.stream.nav(message);
        else if (message.type === "dialog") await viewer.stream.dialog(message);
        else await viewer.stream.input(message);
      } catch (error) { send(viewer.conn, { type: "held", reason: (error as { reason?: unknown })?.reason === "bad_message" ? "bad_message" : "no_page" }); }
      finally { clearInterval(keep); viewer.queued -= 1; }
    });
  };

  const endViewer = (entry: Entry): void => {
    const viewer = entry.viewer;
    if (!viewer) return;
    entry.viewer = null;
    viewer.unsubscribe();
    viewer.gate.setViewing(false);
    try { viewer.stream.close(); } catch { /* the stream is gone either way */ }
  };

  const ensureServer = (): Promise<void> => {
    if (mounted || origin) return Promise.resolve();
    starting ??= new Promise<void>((resolve, reject) => {
      const s = createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404, { "Content-Length": 0 }); res.end(); } });
      s.on("upgrade", (req, socket, head) => { if (!upgrade(req, socket, head)) socket.destroy(); });
      s.once("error", reject);
      // Loopback only, never 0.0.0.0: the host that wants more mounts the handler on its own server.
      s.listen(0, "127.0.0.1", () => { s.unref(); server = s; origin = `http://127.0.0.1:${(s.address() as AddressInfo).port}`; resolve(); });
    });
    return starting;
  };

  const release = async (tag: string): Promise<void> => {
    for (const mark of opening.get(tag) ?? []) mark.cancelled = true;
    const entry = byTag.get(tag);
    if (!entry) return;
    byTag.delete(tag);
    byId.delete(entry.id);
    entry.released = true;
    for (const conn of [...entry.pending, ...(entry.viewer ? [entry.viewer.conn] : [])]) { send(conn, { type: "ended", reason: "released" }); conn.close(CLOSE_CODES.released, "released"); }
    entry.pending.clear();
    const viewer = entry.viewer;
    endViewer(entry);
    // The gate is the session's, so it ends with it even when no viewer ever took it.
    (options.gates ?? drivingGates)(tag).end();
    void viewer;
  };

  return {
    handle,
    upgrade,
    async open(tag, cdpUrl) {
      if (closed) throw new Error("the live view is closed");
      const known = byTag.get(tag);
      if (known?.view) return known.view;
      const mark = { cancelled: false };
      const marks = opening.get(tag) ?? new Set<{ cancelled: boolean }>();
      marks.add(mark);
      opening.set(tag, marks);
      try {
        await ensureServer();
        // A close or a release that came while the server was starting is not undone by the open that was waiting for it.
        if (closed || mark.cancelled) throw new Error("the live view was closed, or the session released, while its viewer was being opened");
      } finally {
        marks.delete(mark);
        if (marks.size === 0 && opening.get(tag) === marks) opening.delete(tag);
      }
      const raced = byTag.get(tag);
      if (raced?.view) return raced.view;
      const entry: Entry = { tag, id: newViewerId(), token: newToken(), cdpUrl, view: null, released: false, viewer: null, pending: new Set() };
      const url = `${origin}${prefix}/v/${entry.id}#t=${entry.token}`;
      entry.view = { fullscreen: url, framed: url, pages: [] };
      byTag.set(tag, entry);
      byId.set(entry.id, entry);
      return entry.view;
    },
    known: (tag) => { const entry = byTag.get(tag); return entry && !entry.released ? entry.view : null; },
    driving: (tag) => { const entry = byTag.get(tag); return !!entry?.viewer && (options.gates ?? drivingGates)(tag).state() === "person"; },
    tracked: () => ({ sessions: byTag.size, opening: [...opening.values()].reduce((n, marks) => n + marks.size, 0) }),
    release,
    async close() {
      closed = true;
      for (const marks of opening.values()) for (const mark of marks) mark.cancelled = true;
      // An open that is starting the server finishes (and is refused) before the server is looked for: nothing is left listening.
      if (starting) await starting.catch(() => undefined);
      for (const tag of [...byTag.keys()]) await release(tag);
      const s = server;
      server = null;
      if (s) await new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });
    },
  };
}
