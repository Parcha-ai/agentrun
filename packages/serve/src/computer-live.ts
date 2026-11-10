// The run-side viewer of a desktop's or a phone's screen (REGISTRATION.md): the runner's computerForClaim opens it as it
// claims the run's computer (openClaimView, which runner/main.ts composes in). It starts the viewer's endpoint on loopback
// (port 0), mints the viewer's path id and token, and hands them over in the store under the run's claim
// (store.liveViewers, the token sealed), as the browser's viewer is handed over (browser-live.ts). The server finds the row,
// serves the viewer's page itself (computer-viewer.ts) under /v2/runs/{id}/computer/live/v/<id>, and proxies only the
// viewer's WebSocket here, from its own origin.
//
// The WebSocket speaks pi-browser's live-view protocol: hello{token} first, then ready{takeOver: true}; the screen's frames
// as binary messages ([u16 w][u16 h][image], w and h the screen's real pixels, the input space), each sent only after the
// viewer acked the one before ({type: "ack"}, once drawn); take and give; hold and status as the hold changes; held,
// refused and ended. Its input is the viewer's events (ViewerEvent), mapped by one createActionMapper per take (a new one
// each time a take begins) and sent to the watch's input only while the person holds the computer: otherwise it is
// answered held ("Take over to drive."). Whether the person holds it is asked of the run's own hold at the moment of
// sending (ViewerHold.driving), so input stops the moment a take ends, before its end is committed and heard. What a take
// pressed and never released (the mapper's release(): button ups) is let go when the viewer loses focus, before a hand
// back, and once when a take ends on the run's side or the viewer goes. The view-only rule is this server's, never a
// vendor's flag.
//
// One viewer per computer: a second socket is refused viewer_in_use. The viewer closing or losing its socket mid-take is
// the hold's away (again once a take it was waiting for lands, if it lands after). close("released" | "ended") drops the
// row under the claim, ends the socket, the watch and the endpoint. Re-registering the same tag (a relaunch) replaces the
// row, and the old viewer is ended. Every frame the watch hands over is acked once: drawn, replaced, or let go with its
// viewer. The token is in no log, no error and no row in plaintext.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type ActionMapper, createActionMapper, type InputAction, redactWords, type Result, type ScreenFrame, type ScreenWatch, type ScreenWatchHandlers, type ViewerEvent, type WatchOptions } from "@parcha/agentrun-computer";
import { acceptWebSocket, CLOSE_CODES, encodeFrame, tokenMatches, type WsConn } from "@parcha/pi-browser/live-view";
import type { LiveViewerStore } from "./browser-live.js";
import { type ComputerCallStore, computerHoldOf, handBackComputer, takeOverComputer } from "./computer-commands.js";
import { type ComputerHoldChange, onComputerHold } from "./runner/computer-journal.js";
import { sealColumn, sealedAt } from "./store/seal.js";
import type { Claim } from "./store/store.js";
import type { ComputerHold, HoldEnd, HoldState } from "./workspace/computer-hold.js";

export type { HoldEnd, HoldState } from "./workspace/computer-hold.js";

/** Where the viewer's endpoint listens: the runner's loopback address alone. */
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the one address the run-side computer viewer listens on
const TAG = /^[A-Za-z0-9._:-]{1,200}$/;
/** Input messages are small: a whole message over this ends the connection. */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** The bounds a viewer is held to (pi-browser's server.ts keeps the same): how long a connection may stay silent before
 *  its hello and how many may wait for one; past `slowViewerBytes` unsent no frame is sent (nor the watch acked) until the
 *  socket drains, and past `maxBufferedBytes` the viewer is cut off (refused slow_viewer); at most `maxQueuedInput`
 *  events wait behind the one being sent, the rest answered held busy; a frame left unacked past `ackIdleMs` ends the
 *  viewer (a take in progress handed back through the hold's away); the ups a leaving viewer's take sends, and the watch's
 *  close, are waited for `settleMs` at most, then let be. */
export const VIEWER_LIMITS = { helloMs: 5_000, maxPending: 8, slowViewerBytes: 512 * 1024, maxBufferedBytes: 4 * 1024 * 1024, maxQueuedInput: 32, ackIdleMs: 60_000, settleMs: 5_000 } as const;
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

/** A committed change of the hold, as the runner signals it (computer-journal.ts onComputerHold): its state, and when a
 *  take ended, why and the hold's words. */
export type HoldChange = ComputerHoldChange;

/** The hold the viewer drives: the run's computer's, through viewerHoldOf. */
export interface ViewerHold {
  /** Who drives, as the store has it. */
  state(): HoldState | Promise<HoldState>;
  /** The person's Take over: pending until the agent's step in flight ends, then person. */
  take(): Promise<{ readonly hold: HoldState }>;
  /** Hand back; it also answers an open ask "done" (first wins). */
  give(): Promise<{ readonly hold: HoldState }>;
  /** The viewer closed or lost its socket mid-take: back to the agent at once. */
  away(): unknown;
  /** Any person input while held: resets the 15-minute idle bound, where the hold keeps one. */
  touched?(): void;
  /** Whether the person drives the computer this moment, as the run's own hold has it when it changes, before the change
   *  is committed and `on` hears it: input goes to the computer only while this says so. Absent: as `on` last said. */
  driving?(): boolean;
  /** Each committed change, after its entry; returns the unsubscribe. */
  on(listener: (event: HoldChange) => void): () => void;
}

/** tl-places' four calls on a run's hold (computer-commands.ts, runner/computer-journal.ts), as their signatures stand. */
export type PlacesHold<S> = {
  computerHoldOf(store: S, runId: string): Promise<HoldState>;
  takeOverComputer(store: S, runId: string): Promise<{ readonly hold: HoldState }>;
  handBackComputer(store: S, runId: string, body?: { readonly outcome?: "done" | "cancelled" }): Promise<{ readonly hold: HoldState }>;
  onComputerHold(runId: string, listener: (change: HoldChange) => void): () => void;
};

/** The run's own hold in the runner's process (workspace/computer-hold.ts, computerForClaim's): what changes at once. */
export type RunnersHold = Pick<ComputerHold, "state" | "away" | "touched">;

/** The four calls as the runner has them. */
export const PLACES: PlacesHold<ComputerCallStore> = { computerHoldOf, takeOverComputer, handBackComputer, onComputerHold };

/** Run `runId`'s hold as the viewer drives it: who drives, Take over and Hand back through tl-places' calls on `store`, the
 *  same the routes make (a take-over or hand-back row the runner applies), and the committed changes through its signal;
 *  away, touched and who drives this moment through the run's own hold (`local`). Hand back answers an open ask "done";
 *  away ends the take `away` and answers no ask. */
export function viewerHoldOf<S>(places: PlacesHold<S>, store: S, runId: string, local: RunnersHold): ViewerHold {
  return {
    state: () => places.computerHoldOf(store, runId),
    take: () => places.takeOverComputer(store, runId),
    give: () => places.handBackComputer(store, runId, { outcome: "done" }),
    away: () => local.away(),
    touched: () => local.touched(),
    driving: () => local.state() === "person",
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
  /** How the computer takes input (createActionMapper's kind): a desktop's, an Android phone's or an iPhone's. */
  input: "desktop" | "android" | "ios";
  /** The computer's ref id. */
  tag: string;
  watch: ComputerWatchOf;
  hold: ViewerHold;
  /** The frames' width at most, and their JPEG quality (the computer's defaults when absent). */
  maxWidth?: number;
  quality?: number;
  /** For tests: the bounds (VIEWER_LIMITS), the timers the hello's wait runs on, a socket's unsent bytes as read, and each
   *  socket as it is upgraded. `log`: a line in words for a wait let be (default stderr). */
  limits?: Partial<typeof VIEWER_LIMITS>;
  log?: (line: string) => void;
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
  bufferedOf?: (conn: WsConn) => number;
  sockets?: (socket: Duplex) => void;
};

/** Why a view was not opened: a stale claim (nothing written), a tag or a kind it does not take, or a failure in words. */
export type OpenedComputerView = { ok: true; view: ComputerView } | { ok: false; refused: "fenced" | "bad_tag" | "kind" | "failed"; message: string };

/** What computerForClaim hands its openComputerView dep: the store and seal key it was given, the run's claim, the
 *  computer's kind, input and ref id, the launched computer's watch (provider.watch(ref, handlers, options) bound to its
 *  ref: this opener gives the handlers and the signal), and the run's own hold (workspace/computer-hold.ts). */
export type ClaimViewArgs = {
  readonly store: unknown;
  readonly sealKey: Buffer | undefined;
  readonly claim: unknown;
  readonly kind: "desktop" | "phone";
  readonly input: "desktop" | "android" | "ios";
  readonly tag: string;
  readonly watch: ComputerWatchOf;
  readonly hold: unknown;
};

/** The runner's opener for computerForClaim's openComputerView dep (runner/main.ts runnerComputers): the view of a run's
 *  desktop or phone under its claim, on the store the claim was given, held through viewerHoldOf over tl-places' calls on
 *  that store and the run's own hold beneath. With no seal key no token can be sealed, and no view is opened. */
export const openClaimView = (args: ClaimViewArgs): Promise<OpenedComputerView> => {
  if (!args.sealKey) return Promise.resolve({ ok: false, refused: "failed", message: "this runner has no seal key, so no viewer's token can be handed over" });
  const claim = args.claim as Claim;
  const store = args.store as LiveViewerStore & ComputerCallStore;
  return openComputerView({
    store, sealKey: args.sealKey, claim, kind: args.kind, input: args.input, tag: args.tag, watch: args.watch,
    hold: viewerHoldOf(PLACES, store, claim.runId, args.hold as RunnersHold),
  });
};

/** What a viewer sends: its hello, its hands, its acks, its focus lost, and its events. */
type ViewerMessage = { type: "hello"; token: string } | { type: "take" } | { type: "give" } | { type: "ack" } | { type: "blur" } | { type: "text"; text: string } | ViewerEvent;

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
    case "blur":
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

/** The view of a desktop's or a phone's screen, handed over under `input.claim`. It never throws: an open that fails is
 *  refused "failed" in its words, having left nothing listening and nothing subscribed, and the opens after it go on. */
export async function openComputerView(input: OpenComputerView): Promise<OpenedComputerView> {
  const { claim, kind, tag } = input;
  if (!TAG.test(tag)) return { ok: false, refused: "bad_tag", message: "the computer's ref id is not a tag a viewer takes (1 to 200 of A-Z a-z 0-9 . _ : -)" };
  const fits = kind === "desktop" ? input.input === "desktop" : input.input === "android" || input.input === "ios";
  if ((kind !== "desktop" && kind !== "phone") || !fits) return { ok: false, refused: "kind", message: `a ${String(kind)} viewer takes ${kind === "desktop" ? "desktop" : "android or ios"} input, not ${String(input.input)}` };
  const key = `${claim.runId}\n${kind}\n${tag}`;
  const mine = (opening.get(key) ?? Promise.resolve())
    .then(() => openOne(input, key))
    .catch((error: unknown): OpenedComputerView => ({ ok: false, refused: "failed", message: `the ${kind}'s live view could not be opened: ${redactWords((error as Error)?.message ?? String(error))}` }));
  opening.set(key, mine);
  void mine.then(() => {
    if (opening.get(key) === mine) opening.delete(key);
  });
  return mine;
}

async function openOne(input: OpenComputerView, key: string): Promise<OpenedComputerView> {
  const { store, sealKey, claim, kind, tag, watch, hold } = input;
  const limits = { ...VIEWER_LIMITS, ...input.limits };
  const timers = input.timers ?? { set: (run: () => void, ms: number) => setTimeout(run, ms).unref(), clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
  const bufferedOf = input.bufferedOf ?? ((conn: WsConn) => conn.buffered);
  const log = input.log ?? ((line: string) => void process.stderr.write(`agentrun-serve: ${line}\n`));
  /** `work` waited for settleMs at most: past it the caller goes on, and says so in words. Never rejects. */
  const settled = (work: Promise<unknown>, what: string): Promise<void> => new Promise((resolve) => {
    let done = false;
    const handle = timers.set(() => {
      if (done) return;
      done = true;
      log(`the ${kind}'s ${what} did not answer within ${limits.settleMs} ms; going on without it`);
      resolve();
    }, limits.settleMs);
    void work.catch(() => undefined).then(() => {
      if (done) return;
      done = true;
      timers.clear(handle);
      resolve();
    });
  });
  // A relaunch of the same computer: the old view goes first, its row with it, and its viewer is told it ended.
  await opened.get(key)?.close("ended");

  const id = randomBytes(16).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  let closed = false;
  let origin = "";
  const pending = new Set<WsConn>();
  type Parked = { frame: ScreenFrame; ack: () => void };
  /** `leaving`: the viewer went, and its watch is not let go yet (its ups are being sent): a frame then waits, unacked. */
  type Viewer = { conn: WsConn; watch?: ScreenWatch; abort: AbortController; ack?: () => void; parked?: Parked; chain: Promise<void>; queued: number; idle?: unknown; leaving?: boolean };
  let viewer: Viewer | null = null;
  let state: HoldState = "agent";
  /** Moves on with every take and every hand back: an event queued under one take is never sent under the next. */
  let epoch = 0;
  /** This take's mapper of the viewer's events: one per take, a new one each time a take begins. */
  let mapper: ActionMapper = createActionMapper(input.input);
  /** The viewer went while a take was pending or held, or while its Take over was being written: a take that lands after
   *  it goes back at once (the hold's away). */
  let awayOwed = false;
  /** A Take over is being written (hold.take() not answered yet). */
  let taking = false;
  const newTake = (): void => {
    epoch += 1;
    mapper.release();
    mapper = createActionMapper(input.input);
  };

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
  /** The viewer is let go: the frame it holds back and the frame it has not acked are acked, so the watch is never left
   *  waiting on an ack nobody will send. */
  const letGoFrames = (current: Viewer): void => {
    const { parked, ack } = current;
    current.parked = undefined;
    current.ack = undefined;
    acked(current);
    parked?.ack();
    ack?.();
  };
  /** One frame to the viewer, its ack held until the viewer drew it; held back whole while the viewer is slow, in one slot:
   *  a newer frame takes the slot, and the one it replaced is acked. */
  const sendFrame = (current: Viewer, frame: ScreenFrame, ack: () => void): void => {
    const conn = current.conn;
    // A viewer that went, its watch not let go yet: the frame waits in the slot (acked when the watch is let go), so the
    // watch is not asked for frame after frame nobody draws.
    if (current.leaving && viewer !== current) {
      const replaced = current.parked;
      current.parked = { frame, ack };
      replaced?.ack();
      return;
    }
    if (viewer !== current || conn.closed) return ack();
    awaitAck(current);
    if (bufferedOf(conn) > limits.maxBufferedBytes) {
      ack();
      return refuse(conn, "slow_viewer");
    }
    if (bufferedOf(conn) > limits.slowViewerBytes) {
      const replaced = current.parked;
      current.parked = { frame, ack };
      replaced?.ack();
      return;
    }
    // The next frame is asked for once the viewer has drawn this one (its ack). A frame still unacked when a newer one comes
    // (a watch that does not wait for its ack) is acked now: the newer one is what the viewer draws.
    const stale = current.ack;
    current.ack = ack;
    stale?.();
    if (!conn.send(encodeFrame(frame.bytes, frame.width, frame.height), () => resume(conn))) {
      current.ack = undefined;
      acked(current);
      ack();
    }
  };

  /** What this take pressed and has not released (the mapper's ups), let go once, in order behind the input before it,
   *  whatever the hold says now: ups only lift. */
  const liftHeld = (current: Viewer | null): Promise<void> => {
    const ups = mapper.release();
    if (ups.length === 0 || !current) return Promise.resolve();
    // Sent even if the viewer went meanwhile: its watch takes them until it is closed.
    const lifted = current.chain.then(async () => {
      await current.watch?.input(ups).catch(() => undefined);
    });
    current.chain = lifted;
    return lifted;
  };

  /** The hold moved (a committed change, or Take over's and Hand back's own answers): the viewer is told once per change,
   *  and each end of a take with why. A take that begins is a new take, whoever began it; a take that ends lets go of what
   *  it held. */
  const moved = (event: HoldChange): void => {
    const before = state;
    state = event.state;
    if (before === "agent" && event.state !== "agent") newTake();
    if (event.state === "agent") {
      awayOwed = false;
      if (before !== "agent") void liftHeld(viewer);
    } else if (!viewer && awayOwed && !closed) {
      // The viewer went while this take waited for the runner: it goes back now that it has landed.
      void Promise.resolve().then(() => hold.away()).catch(() => undefined);
    }
    const conn = viewer?.conn;
    if (!conn) return;
    if (event.state === "person") {
      if (before !== "person") send(conn, { type: "hold", held: true });
    } else if (event.ended && before !== "agent") send(conn, { type: "hold", held: false, reason: event.ended, ...(event.message ? { message: event.message } : {}) });
    else if (before !== event.state) send(conn, { type: "status", drive: event.state });
  };
  const unsubscribe = hold.on(moved);

  /** The viewer is gone: what its take held is let go, its watch ends, and a take it held or was waiting for is the hold's
   *  away. */
  const endViewer = (conn: WsConn): void => {
    if (viewer?.conn !== conn) return;
    const gone = viewer;
    viewer = null;
    acked(gone);
    const ups = mapper.release();
    // The watch ends before its frames are acked: an ack then asks for no frame more.
    const stop = (): void => {
      gone.leaving = false;
      gone.abort.abort();
      letGoFrames(gone);
      void settled(Promise.resolve(gone.watch?.close()), "watch's close");
    };
    if (ups.length && gone.watch) {
      // The ups go behind the input still being sent (a press in flight is never overtaken by its own release), bounded.
      gone.leaving = true;
      const watch = gone.watch;
      void settled(gone.chain.then(() => watch.input(ups)), "release of the buttons held").then(stop);
    } else stop();
    if (!closed && (taking || state === "person" || state === "pending")) {
      awayOwed = true;
      // A Take over still being written has nothing to hand back yet: its landing does (moved, onHands).
      if (state !== "agent") void Promise.resolve().then(() => hold.away()).catch(() => undefined);
    }
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

  /** Whether the viewer's input goes to the computer now: the person holds it as committed, and as the run's own hold has
   *  it this moment (a take it ended is over before its end is heard). */
  const drivingNow = (): boolean => state === "person" && hold.driving?.() !== false;

  /** One event, in order behind the ones before it: mapped and sent only while the person holds the computer, under the
   *  take it came in. Mapped at its turn, so an event never sent is never remembered as pressed. */
  const onInput = (current: Viewer, message: Exclude<ViewerMessage, { type: "hello" | "take" | "give" | "ack" | "blur" }>): void => {
    const conn = current.conn;
    if (!drivingNow()) {
      // A hover outside a hold is no input anyone meant.
      if (!(message.type === "mouse" && message.action === "move")) send(conn, { type: "held", reason: state === "pending" ? "taking" : "not_taken", message: state === "pending" ? "Taking over: wait for the agent's step to end." : NOT_TAKEN });
      return;
    }
    // At most so many wait behind the one being sent: the rest are dropped, said, never queued without bound.
    if (current.queued >= limits.maxQueuedInput) return send(conn, { type: "held", reason: "busy", message: "Too much input at once: that input was dropped." });
    current.queued += 1;
    const under = epoch;
    current.chain = current.chain.then(async () => {
      try {
        // Taken back meanwhile (the take ended, a new one began, or the viewer went): nothing more is sent.
        if (viewer !== current || under !== epoch || !drivingNow()) return;
        const actions: InputAction[] | { readonly message: string } = message.type === "text" ? [{ type: "type", text: message.text }] : mapper.map(message);
        if (!Array.isArray(actions)) return send(conn, { type: "held", reason: "refused", message: actions.message });
        if (actions.length === 0) return;
        if (!current.watch) return send(conn, { type: "held", reason: "failed", message: "The computer's screen is not open yet: try again in a moment." });
        hold.touched?.();
        const result = await current.watch.input(actions).catch((error: unknown) => ({ ok: false as const, error: { message: (error as Error)?.message ?? String(error) } }));
        if (!result.ok && viewer === current) send(conn, { type: "held", reason: "failed", message: redactWords(result.error.message) });
      } finally {
        current.queued -= 1;
      }
    });
  };

  const onHands = async (current: Viewer, which: "take" | "give"): Promise<void> => {
    const conn = current.conn;
    try {
      if (which === "take") {
        if (state === "person") return send(conn, { type: "hold", held: true });
        newTake();
        // Marked before the write: a viewer that goes meanwhile owes the take an away once it lands.
        taking = true;
        let answer: { readonly hold: HoldState };
        try {
          answer = await hold.take();
        } finally {
          taking = false;
        }
        // The answer moves the viewer on from the agent, never back from a change already heard.
        if (viewer === current && state === "agent" && answer.hold !== "agent") moved({ state: answer.hold });
        // Gone meanwhile, and the take landed: back at once.
        else if (viewer !== current && awayOwed && !closed && answer.hold !== "agent") void Promise.resolve().then(() => hold.away()).catch(() => undefined);
        return;
      }
      // Hand back: what is queued is not sent, what this take holds is let go, then the hold is given.
      epoch += 1;
      await liftHeld(current);
      const answer = await hold.give();
      if (viewer === current && answer.hold === "agent" && state !== "agent") moved({ state: "agent", ended: "given" });
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
    awayOwed = false;
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
    if (message.type === "blur") return void liftHeld(current);
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
    input.sockets?.(socket);
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
  const stopServer = (): Promise<void> => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

  let put: boolean;
  try {
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
    const sealed = sealColumn(sealKey, sealedAt.liveViewer(claim.runId, kind, tag), token);
    put = await store.liveViewers.put(claim, { kind, tag, port, id, sealed }).catch(() => false);
  } catch (error) {
    // Nothing is left of an open that failed: no subscription, and nothing listening.
    closed = true;
    unsubscribe();
    await stopServer();
    throw error;
  }
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
        // What its take holds down is let go first, behind the input still being sent, bounded.
        const ups = mapper.release();
        if (ups.length && gone.watch) {
          const watch = gone.watch;
          await settled(gone.chain.then(() => watch.input(ups)), "release of the buttons held");
        }
        gone.abort.abort();
        letGoFrames(gone);
        await settled(Promise.resolve(gone.watch?.close()), "watch's close");
      }
      await stopServer();
    },
  };
  opened.set(key, view);
  return { ok: true, view };
}
