// The run-side viewer of a desktop's or a phone's screen (REGISTRATION.md): tl-places calls openComputerView as it claims
// the run's computer. It starts the viewer's endpoint on loopback (port 0), mints the viewer's path id and token, and
// hands them over in the store under the run's claim (store.liveViewers, the token sealed), as the browser's viewer is
// handed over (browser-live.ts). The server finds the row, serves the viewer's page itself (computer-viewer.ts) under
// /v2/runs/{id}/computer/live/v/<id>, and proxies only the viewer's WebSocket here, from its own origin.
//
// The WebSocket speaks pi-browser's live-view protocol: hello{token} first, then ready{takeOver: true}; the screen's frames
// as binary messages ([u16 w][u16 h][image], w and h the screen's real pixels, the input space), each sent only after the
// viewer acked the one before ({type: "ack"}, once drawn); take and give; hold and status as the hold changes; held,
// refused and ended. Its input is the viewer's events (ViewerEvent), mapped by toAction for the computer's input kind and
// sent to the watch's input only while the person holds the computer: otherwise it is answered held ("Take over to
// drive."). The view-only rule is this server's, never a vendor's flag.
//
// One viewer per computer: a second socket is refused viewer_in_use. The viewer closing or losing its socket mid-take is
// the hold's away. close("released" | "ended") drops the row under the claim, ends the socket, the watch and the endpoint.
// Re-registering the same tag (a relaunch) replaces the row, and the old viewer is ended. The token is in no log, no error
// and no row in plaintext.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { redactWords, type Result, type ScreenFrame, type ScreenWatch, type ScreenWatchHandlers, toAction, type ViewerEvent, type WatchOptions } from "@parcha/agentrun-computer";
import { acceptWebSocket, CLOSE_CODES, encodeFrame, tokenMatches, type WsConn } from "@parcha/pi-browser/live-view";
import type { LiveViewerStore } from "./browser-live.js";
import { sealColumn, sealedAt } from "./store/seal.js";
import type { Claim } from "./store/store.js";

/** Where the viewer's endpoint listens: the runner's loopback address alone. */
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the one address the run-side computer viewer listens on
const TAG = /^[A-Za-z0-9._:-]{1,200}$/;
/** Input messages are small: a whole message over this ends the connection. */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** The bounds a viewer is held to (pi-browser's server.ts keeps the same): how long a connection may stay silent before
 *  its hello and how many may wait for one; past `slowViewerBytes` unsent no frame is sent (nor the watch acked) until the
 *  socket drains, and past `maxBufferedBytes` the viewer is cut off (refused slow_viewer); at most `maxQueuedInput`
 *  events wait behind the one being sent, the rest answered held busy; a frame left unacked past `ackIdleMs` ends the
 *  viewer (a take in progress handed back through the hold's away). */
export const VIEWER_LIMITS = { helloMs: 5_000, maxPending: 8, slowViewerBytes: 512 * 1024, maxBufferedBytes: 4 * 1024 * 1024, maxQueuedInput: 32, ackIdleMs: 60_000 } as const;
/** A viewer whose frame waits unacked past ackIdleMs is ended in these words. */
export const STOPPED_ANSWERING = "This view stopped answering; open the live view again.";
/** Its close code. */
const IDLE_CLOSE = 4408;
/** The close code of a viewer cut off for not reading (4000-4999 are the applications'). */
const SLOW_VIEWER_CLOSE = 4429;
/** Bounds on what a viewer's event may carry. */
const COORDINATE = 65_535;
const WHEEL = 100_000;
const KEY = 64;
const TEXT = 12 * 1024;

/** Who drives the computer now (tl-places' computer-hold). */
export type HoldState = "agent" | "pending" | "person";
/** Why a person's hold ended. */
export type HoldEnd = "given" | "answered" | "idle" | "away" | "released";
/** A committed change of the hold: its state, and when a hold ended, why and the hold's words. */
export type HoldEvent = { state: HoldState; ended?: HoldEnd; message?: string };

/** The hold the viewer drives: tl-places' computer-hold for this run's computer, through viewerHoldOf. */
export interface ViewerHold {
  state(): HoldState | Promise<HoldState>;
  /** The person's Take over: pending until the agent's step in flight ends, then person. */
  take(): Promise<{ hold: HoldState }>;
  /** Hand back; it also answers an open ask "done" (first wins). */
  give(): Promise<{ hold: HoldState }>;
  /** The viewer closed or lost its socket mid-take: back to the agent at once. */
  away(): Promise<unknown>;
  /** Any person input while held: resets the 15-minute idle bound, where the hold keeps one. */
  touched?(): void;
  /** Each committed change, after its entry; returns the unsubscribe. */
  on(listener: (event: HoldEvent) => void): () => void;
}

/** tl-places' computer-hold functions (places/computers-cut), as their signatures stand. */
export type PlacesHold<S> = {
  computerHoldOf(store: S, runId: string): HoldState | Promise<HoldState>;
  takeOverComputer(store: S, runId: string): Promise<{ hold: HoldState }>;
  handBackComputer(store: S, runId: string, options: { outcome?: "done" | "cancelled" }): Promise<{ hold: HoldState; outcome?: string }>;
  onComputerHold(runId: string, listener: (event: HoldEvent) => void): () => void;
};

/** Run `runId`'s computer-hold as the viewer drives it, over tl-places' functions on `store`. Hand back answers an open ask
 *  "done"; away hands back with no outcome. */
export function viewerHoldOf<S>(places: PlacesHold<S>, store: S, runId: string): ViewerHold {
  return {
    state: () => places.computerHoldOf(store, runId),
    take: () => places.takeOverComputer(store, runId),
    give: () => places.handBackComputer(store, runId, { outcome: "done" }),
    // TODO(tl-places): away() once computer-hold has one (back to the agent at once, ended "away"); until then the hand
    // back with no outcome, which answers no ask.
    away: () => places.handBackComputer(store, runId, {}),
    // TODO(tl-places): touched() once computer-hold keeps its idle bound from the viewer's input.
    on: (listener) => places.onComputerHold(runId, listener),
  };
}

/** The computer's live frames and input: its provider's watch on the computer's ref (provider.watch(ref, ...)). */
export type ComputerWatchOf = (handlers: ScreenWatchHandlers, options: WatchOptions) => Promise<Result<ScreenWatch>>;

export interface ComputerView {
  /** The computer's session is over: the row is dropped under the claim, the token dies, an open socket gets "ended". */
  close(why: "released" | "ended"): Promise<void>;
}

export type OpenComputerView = {
  store: LiveViewerStore;
  sealKey: Buffer;
  claim: Claim;
  kind: "desktop" | "phone";
  /** How the computer takes input (toAction's kind): a desktop's, an Android phone's or an iPhone's. */
  input: "desktop" | "android" | "ios";
  /** The computer's ref id. */
  tag: string;
  watch: ComputerWatchOf;
  hold: ViewerHold;
  /** The frames' width at most, and their JPEG quality (the computer's defaults when absent). */
  maxWidth?: number;
  quality?: number;
  /** For tests: the bounds (VIEWER_LIMITS), the timers the hello's wait runs on, and a socket's unsent bytes as read. */
  limits?: Partial<typeof VIEWER_LIMITS>;
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
  bufferedOf?: (conn: WsConn) => number;
};

export type OpenedComputerView = { ok: true; view: ComputerView } | { ok: false; refused: "fenced" | "bad_tag" | "kind"; message: string };

/** What a viewer sends: its hello, its hands, its acks and its events. */
type ViewerMessage = { type: "hello"; token: string } | { type: "take" } | { type: "give" } | { type: "ack" } | { type: "text"; text: string } | ViewerEvent;

const finite = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;
const word = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const int = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** One text message from a viewer, checked field by field; null for anything that is not exactly one of this protocol. */
export function parseViewerMessage(raw: string): ViewerMessage | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const keys = Object.keys(m).length;
  switch (m.type) {
    case "hello":
      return word(m.token, 256) && keys === 2 ? { type: "hello", token: m.token } : null;
    case "take":
    case "give":
    case "ack":
      return keys === 1 ? { type: m.type } : null;
    case "text":
      return word(m.text, TEXT) ? { type: "text", text: m.text } : null;
    case "mouse":
      if (!["down", "up", "move"].includes(m.action as string) || !finite(m.x, COORDINATE) || !finite(m.y, COORDINATE) || !int(m.button ?? 0, 0, 4) || !int(m.buttons ?? 0, 0, 31) || !int(m.clickCount ?? 1, 0, 3) || !int(m.modifiers ?? 0, 0, 15)) return null;
      return { type: "mouse", action: m.action as "down" | "up" | "move", x: m.x, y: m.y, button: (m.button as number) ?? 0, buttons: (m.buttons as number) ?? 0, clickCount: (m.clickCount as number) ?? 1, modifiers: (m.modifiers as number) ?? 0 };
    case "wheel":
      return finite(m.x, COORDINATE) && finite(m.y, COORDINATE) && finite(m.dx, WHEEL) && finite(m.dy, WHEEL) ? { type: "wheel", x: m.x, y: m.y, dx: m.dx, dy: m.dy } : null;
    case "key":
      if (!["down", "up", "char"].includes(m.action as string) || !word(m.key, KEY) || typeof m.code !== "string" || m.code.length > KEY || !int(m.modifiers ?? 0, 0, 15)) return null;
      if (m.text !== undefined && (typeof m.text !== "string" || m.text.length > KEY)) return null;
      return { type: "key", action: m.action as "down" | "up" | "char", key: m.key, code: m.code, ...(m.text !== undefined ? { text: m.text as string } : {}), modifiers: (m.modifiers as number) ?? 0 };
    case "tap":
      return finite(m.x, COORDINATE) && finite(m.y, COORDINATE) ? { type: "tap", x: m.x, y: m.y } : null;
    case "swipe":
      return finite(m.x1, COORDINATE) && finite(m.y1, COORDINATE) && finite(m.x2, COORDINATE) && finite(m.y2, COORDINATE) && finite(m.ms, 60_000) ? { type: "swipe", x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2, ms: m.ms } : null;
    case "button":
      return ["back", "home", "recents"].includes(m.name as string) ? { type: "button", name: m.name as "back" | "home" | "recents" } : null;
    default:
      return null;
  }
}

/** What the viewer is told: the browser's messages, with the hold's three states as `drive`. */
type ServerMessage =
  | { type: "ready"; drive: HoldState; takeOver: true; held: boolean; kind: "desktop" | "phone"; input: "desktop" | "android" | "ios" }
  | { type: "status"; drive: HoldState }
  | { type: "hold"; held: true }
  | { type: "hold"; held: false; reason: HoldEnd; message?: string }
  | { type: "take_refused"; message: string }
  | { type: "held"; reason: "not_taken" | "taking" | "bad_message" | "refused" | "failed" | "busy"; message: string }
  | { type: "refused"; reason: "unauthorized" | "viewer_in_use" | "released" | "bad_message" | "slow_viewer" }
  | { type: "ended"; reason: "released" | "ended" | "gone" | "unreachable" | "refused" | "unsupported"; message: string };

/** The answer to input outside a hold. */
export const NOT_TAKEN = "Take over to drive.";
/** The words of a view's end, by why. */
const ENDED: Record<"released" | "ended", string> = { released: "This computer was released.", ended: "This computer's session has ended." };

/** The views open in this process, by run, kind and tag: a relaunch's registration ends the one before it. */
const opened = new Map<string, { close(why: "released" | "ended"): Promise<void> }>();
/** The opens of each run, kind and tag, one after another: two at once would each start an endpoint and one be orphaned. */
const opening = new Map<string, Promise<unknown>>();

export async function openComputerView(input: OpenComputerView): Promise<OpenedComputerView> {
  const { claim, kind, tag } = input;
  if (!TAG.test(tag)) return { ok: false, refused: "bad_tag", message: "the computer's ref id is not a tag a viewer takes (1 to 200 of A-Z a-z 0-9 . _ : -)" };
  const fits = kind === "desktop" ? input.input === "desktop" : input.input === "android" || input.input === "ios";
  if ((kind !== "desktop" && kind !== "phone") || !fits) return { ok: false, refused: "kind", message: `a ${String(kind)} viewer takes ${kind === "desktop" ? "desktop" : "android or ios"} input, not ${String(input.input)}` };
  const key = `${claim.runId}\n${kind}\n${tag}`;
  const mine = (opening.get(key) ?? Promise.resolve()).then(() => openOne(input, key));
  const settled = mine.catch(() => undefined);
  opening.set(key, settled);
  void settled.then(() => {
    if (opening.get(key) === settled) opening.delete(key);
  });
  return mine;
}

async function openOne(input: OpenComputerView, key: string): Promise<OpenedComputerView> {
  const { store, sealKey, claim, kind, tag, watch, hold } = input;
  const limits = { ...VIEWER_LIMITS, ...input.limits };
  const timers = input.timers ?? { set: (run: () => void, ms: number) => setTimeout(run, ms).unref(), clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
  const bufferedOf = input.bufferedOf ?? ((conn: WsConn) => conn.buffered);
  // A relaunch of the same computer: the old view goes first, its row with it, and its viewer is told it ended.
  await opened.get(key)?.close("ended");

  const id = randomBytes(16).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  let closed = false;
  let origin = "";
  const pending = new Set<WsConn>();
  type Viewer = { conn: WsConn; watch?: ScreenWatch; abort: AbortController; ack?: () => void; parked?: { frame: ScreenFrame; ack: () => void }; chain: Promise<void>; queued: number; idle?: unknown };
  let viewer: Viewer | null = null;
  let state: HoldState = "agent";
  /** Moves on with every take: an event queued under one hold is never sent under the next. */
  let epoch = 0;

  const refuse = (conn: WsConn, reason: "unauthorized" | "viewer_in_use" | "released" | "bad_message" | "slow_viewer"): void => {
    conn.send(JSON.stringify({ type: "refused", reason }));
    conn.close(reason === "slow_viewer" ? SLOW_VIEWER_CLOSE : CLOSE_CODES[reason], reason);
  };
  /** A reply to the viewer; one that does not read what it is sent is cut off past the hard bound, never buffered on. */
  const send = (conn: WsConn, message: ServerMessage): void => {
    if (conn.closed) return;
    if (bufferedOf(conn) > limits.maxBufferedBytes) return refuse(conn, "slow_viewer");
    conn.send(JSON.stringify(message), () => resume(conn));
  };
  /** The socket took what was waiting: a frame held back for a slow viewer goes now. */
  const resume = (conn: WsConn): void => {
    const current = viewer;
    if (!current || current.conn !== conn || !current.parked || conn.closed || bufferedOf(conn) > limits.slowViewerBytes) return;
    const { frame, ack } = current.parked;
    current.parked = undefined;
    sendFrame(current, frame, ack);
  };
  /** A frame waits for the viewer's ack: past ackIdleMs with none, the viewer is ended, and its watch and a take with it. */
  const awaitAck = (current: Viewer): void => {
    if (current.idle !== undefined) return;
    current.idle = timers.set(() => {
      current.idle = undefined;
      if (viewer !== current || current.conn.closed) return;
      send(current.conn, { type: "ended", reason: "refused", message: STOPPED_ANSWERING });
      current.conn.close(IDLE_CLOSE, "idle");
    }, limits.ackIdleMs);
  };
  const acked = (current: Viewer): void => {
    if (current.idle !== undefined) timers.clear(current.idle);
    current.idle = undefined;
  };
  /** One frame to the viewer, its ack held until the viewer drew it; held back whole while the viewer is slow. */
  const sendFrame = (current: Viewer, frame: ScreenFrame, ack: () => void): void => {
    const conn = current.conn;
    if (viewer !== current || conn.closed) return ack();
    awaitAck(current);
    if (bufferedOf(conn) > limits.maxBufferedBytes) return refuse(conn, "slow_viewer");
    if (bufferedOf(conn) > limits.slowViewerBytes) {
      current.parked = { frame, ack };
      return;
    }
    // The next frame is asked for once the viewer has drawn this one (its ack).
    current.ack = ack;
    if (!conn.send(encodeFrame(frame.bytes, frame.width, frame.height), () => resume(conn))) {
      current.ack = undefined;
      acked(current);
      ack();
    }
  };

  /** The hold moved: the viewer is told once per change, and each end of a hold with why. */
  const moved = (event: HoldEvent): void => {
    const before = state;
    state = event.state;
    if (before === "agent" && event.state !== "agent") epoch += 1;
    const conn = viewer?.conn;
    if (!conn) return;
    if (event.state === "person") {
      if (before !== "person") send(conn, { type: "hold", held: true });
    } else if (event.ended && before !== "agent") send(conn, { type: "hold", held: false, reason: event.ended, ...(event.message ? { message: event.message } : {}) });
    else if (before !== event.state) send(conn, { type: "status", drive: event.state });
  };
  const unsubscribe = hold.on(moved);

  /** The viewer is gone: its watch ends, and a take it held or was waiting for is the hold's away. */
  const endViewer = (conn: WsConn): void => {
    if (viewer?.conn !== conn) return;
    const gone = viewer;
    viewer = null;
    acked(gone);
    gone.abort.abort();
    gone.ack = undefined;
    void gone.watch?.close().catch(() => undefined);
    if (!closed && (state === "person" || state === "pending")) void Promise.resolve().then(() => hold.away()).catch(() => undefined);
  };

  const startWatch = async (conn: WsConn): Promise<void> => {
    const current = viewer!;
    const handlers: ScreenWatchHandlers = {
      frame(frame: ScreenFrame, ack: () => void) {
        sendFrame(current, frame, ack);
      },
      ended(error) {
        if (viewer !== current) return;
        send(conn, { type: "ended", reason: error.code, message: redactWords(error.message) });
        conn.close(CLOSE_CODES.browser_closed, "ended");
      },
    };
    const started = await watch(handlers, { signal: current.abort.signal, ...(input.maxWidth ? { maxWidth: input.maxWidth } : {}), ...(input.quality ? { quality: input.quality } : {}) }).catch((error: unknown) => ({ ok: false as const, error: { code: "unreachable" as const, message: (error as Error)?.message ?? String(error) } }));
    if (!started.ok) {
      if (viewer === current) {
        const code = started.error.code === "gone" || started.error.code === "unsupported" || started.error.code === "refused" ? started.error.code : "unreachable";
        send(conn, { type: "ended", reason: code, message: redactWords(started.error.message) });
        conn.close(CLOSE_CODES.browser_closed, "ended");
      }
      return;
    }
    if (viewer !== current) return void (await started.value.close().catch(() => undefined));
    current.watch = started.value;
  };

  /** One event, in order behind the ones before it: sent only while the person holds the computer. */
  const onInput = (current: NonNullable<typeof viewer>, message: Exclude<ViewerMessage, { type: "hello" | "take" | "give" | "ack" }>): void => {
    const conn = current.conn;
    if (state !== "person") {
      // A hover outside a hold is no input anyone meant.
      if (!(message.type === "mouse" && message.action === "move")) send(conn, { type: "held", reason: state === "pending" ? "taking" : "not_taken", message: state === "pending" ? "Taking over: wait for the agent's step to end." : NOT_TAKEN });
      return;
    }
    const actions = message.type === "text" ? [{ type: "type" as const, text: message.text }] : toAction(message, input.input);
    if (!Array.isArray(actions)) return send(conn, { type: "held", reason: "refused", message: actions.message });
    if (actions.length === 0) return;
    // At most so many wait behind the one being sent: the rest are dropped, said, never queued without bound.
    if (current.queued >= limits.maxQueuedInput) return send(conn, { type: "held", reason: "busy", message: "Too much input at once: that input was dropped." });
    hold.touched?.();
    current.queued += 1;
    const under = epoch;
    current.chain = current.chain.then(async () => {
      try {
        // Taken back meanwhile (the hold moved, a new take began, or the viewer went): nothing more is sent.
        if (viewer !== current || state !== "person" || under !== epoch) return;
        if (!current.watch) return send(conn, { type: "held", reason: "failed", message: "The computer's screen is not open yet: try again in a moment." });
        const result = await current.watch.input(actions).catch((error: unknown) => ({ ok: false as const, error: { message: (error as Error)?.message ?? String(error) } }));
        if (!result.ok && viewer === current) send(conn, { type: "held", reason: "failed", message: redactWords(result.error.message) });
      } finally {
        current.queued -= 1;
      }
    });
  };

  const onHands = async (current: NonNullable<typeof viewer>, which: "take" | "give"): Promise<void> => {
    const conn = current.conn;
    try {
      if (which === "take" && state === "person") return send(conn, { type: "hold", held: true });
      if (which === "take") epoch += 1;
      const answer = which === "take" ? await hold.take() : await hold.give();
      if (viewer === current) moved({ state: answer.hold, ...(which === "give" && answer.hold === "agent" && state !== "agent" ? { ended: "given" as const } : {}) });
    } catch (error) {
      if (viewer === current) send(conn, { type: "take_refused", message: redactWords((error as Error)?.message ?? "The computer could not be handed over.") });
    }
  };

  const onHello = async (conn: WsConn, data: string | Buffer, binary: boolean): Promise<void> => {
    pending.delete(conn);
    const message = binary || typeof data !== "string" ? null : parseViewerMessage(data);
    if (message?.type !== "hello" || !tokenMatches(token, message.token) || closed) return refuse(conn, "unauthorized");
    // One viewer per computer, told so, and the first is never replaced.
    if (viewer) return refuse(conn, "viewer_in_use");
    viewer = { conn, abort: new AbortController(), chain: Promise.resolve(), queued: 0 };
    const current = viewer;
    state = await Promise.resolve(hold.state()).catch(() => state);
    if (viewer !== current) return;
    send(conn, { type: "ready", drive: state, takeOver: true, held: state === "person", kind, input: input.input });
    await startWatch(conn);
  };

  const onMessage = (conn: WsConn, data: string | Buffer, binary: boolean): void => {
    const current = viewer;
    if (!current || current.conn !== conn) return;
    const message = binary || typeof data !== "string" ? null : parseViewerMessage(data);
    // Any message from the viewer is a moment to see whether its socket drained.
    resume(conn);
    if (!message || message.type === "hello") return send(conn, { type: "held", reason: "bad_message", message: "That input was not understood." });
    if (message.type === "ack") {
      const ack = current.ack;
      current.ack = undefined;
      if (ack) acked(current);
      return ack?.();
    }
    if (message.type === "take" || message.type === "give") return void onHands(current, message.type);
    onInput(current, message);
  };

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => socket.destroy());
    const deny = (status: string): void => void socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const path = (req.url ?? "/").split("?")[0]!;
    // The server proxies the viewer's socket here with this endpoint's own origin; anything else is refused.
    if (req.headers.origin !== origin) return deny("403 Forbidden");
    if (path !== `/v/${id}/ws` || closed) return deny("404 Not Found");
    if (pending.size >= limits.maxPending) return deny("503 Service Unavailable");
    const conn = acceptWebSocket(req, socket, head, { maxPayload: MAX_MESSAGE_BYTES });
    if (!conn) return;
    pending.add(conn);
    socket.on("drain", () => resume(conn));
    const timer = timers.set(() => void (pending.delete(conn) && refuse(conn, "unauthorized")), limits.helloMs);
    conn.onClose = () => {
      timers.clear(timer);
      pending.delete(conn);
      endViewer(conn);
    };
    conn.onMessage = (data, binary) => {
      if (viewer?.conn === conn) return onMessage(conn, data, binary);
      if (!pending.has(conn)) return;
      timers.clear(timer);
      void onHello(conn, data, binary);
    };
  };

  const server: Server = createServer((req, res) => {
    // The server's check that this viewer still answers (browser-live.ts viewerAnswers): its page's path, 200 while open.
    const path = (req.url ?? "/").split("?")[0];
    const ok = (req.method === "GET" || req.method === "HEAD") && path === `/v/${id}` && !closed;
    res.writeHead(ok ? 200 : 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end();
  });
  server.on("upgrade", upgrade);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const port = (server.address() as AddressInfo).port;
  origin = `http://${LOOPBACK}:${port}`;
  const stopServer = (): Promise<void> => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

  const put = await store.liveViewers.put(claim, { kind, tag, port, id, sealed: sealColumn(sealKey, sealedAt.liveViewer(claim.runId, kind, tag), token) }).catch(() => false);
  if (!put) {
    closed = true;
    unsubscribe();
    await stopServer();
    return { ok: false, refused: "fenced", message: "the run's claim is no longer this runner's: no viewer was handed over" };
  }

  const view: ComputerView = {
    async close(why) {
      if (closed) return;
      closed = true;
      if (opened.get(key) === view) opened.delete(key);
      unsubscribe();
      // Only its own row: a relaunch in another process may have put a newer one under the same kind and tag.
      // TODO(tl-untangle): liveViewers.drop by the row's id in the store, so the read and the drop are one statement.
      const row = (await store.liveViewers.of(claim.runId).catch(() => [])).find((each) => each.kind === kind && each.tag === tag);
      if (row?.id === id) await store.liveViewers.drop(claim, kind, tag).catch(() => undefined);
      const reason = why === "released" ? "released" : "ended";
      for (const conn of [...pending, ...(viewer ? [viewer.conn] : [])]) {
        send(conn, { type: "ended", reason, message: ENDED[why] });
        conn.close(CLOSE_CODES.released, reason);
      }
      pending.clear();
      if (viewer) {
        const gone = viewer;
        viewer = null;
        acked(gone);
        gone.abort.abort();
        await gone.watch?.close().catch(() => undefined);
      }
      await stopServer();
    },
  };
  opened.set(key, view);
  return { ok: true, view };
}
