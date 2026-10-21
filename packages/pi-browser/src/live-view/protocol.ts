// The live view's wire protocol and the seams between its parts: one WebSocket per viewer, JSON text messages both ways, and the
// page's pixels as binary messages. Nothing here touches a socket or a browser, so the server (server.ts), the screencast (stream.ts), the
// viewer page and the driving gate (core/driving.ts) are each built against these types alone.
//
// The seam types of the person/model mutex (DriveState, DrivingGate, DrivingGates) live in core/driving.ts, where the model side uses them; they are
// re-exported from here.
import type { DriveState, DrivingGate, DrivingGates } from "../core/driving.js";
export type { DriveState, DrivingGate, DrivingGates };

// Coordinates in `mouse` and `wheel` are CSS pixels of the page: the `w` x `h` the latest frame carries, not canvas pixels.

/** The viewer's first message, and nothing else is accepted before it. The token is read from the URL fragment by the viewer's script and
 *  never travels in a path, a query or a header. */
export type Hello = { type: "hello"; token: string };

export type MouseButton = "left" | "middle" | "right";
/** CDP's modifier bitmask: Alt 1, Control 2, Meta 4, Shift 8. */
export type Modifiers = number;

export type InputMessage =
  | { type: "mouse"; action: "move" | "down" | "up"; x: number; y: number; button?: MouseButton; /** The buttons held, as MouseEvent.buttons and CDP count them: left 1, right 2, middle 4 (an integer 0..31). A plain hover is 0; absent means the viewer does not say (a press then holds its own button, a move and a release hold none). */ buttons?: number; clickCount?: number; modifiers?: Modifiers }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: Modifiers }
  | { type: "key"; action: "down" | "up"; key: string; code: string; text?: string; windowsVirtualKeyCode?: number; modifiers?: Modifiers }
  /** Typed or pasted text, inserted as it is (Input.insertText). */
  | { type: "text"; text: string };

export type NavMessage =
  | { type: "nav"; action: "url"; url: string }
  | { type: "nav"; action: "back" }
  | { type: "nav"; action: "reload" };

/** Answers the JS dialog the page is showing (alert, confirm, prompt, beforeunload). */
export type DialogAnswer = { type: "dialog"; accept: boolean; promptText?: string };

export type ClientMessage = Hello | InputMessage | NavMessage | DialogAnswer;

export type ServerMessage =
  /** Sent once, after a valid hello. */
  | { type: "ready"; drive: DriveState }
  | { type: "status"; drive: DriveState }
  /** The page shown: its address and title, sent when either changes and at every followed-page change. */
  | { type: "page"; url: string; title: string }
  | { type: "dialog"; kind: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string }
  | { type: "dialog_closed" }
  /** One input or nav message was not delivered, and why. */
  | { type: "held"; reason: "agent_acting" | "no_page" | "bad_message" | "busy" }
  | { type: "refused"; reason: RefusalReason }
  | { type: "ended"; reason: "released" | "browser_closed" };

export type RefusalReason = "unauthorized" | "viewer_in_use" | "released" | "bad_message";

/** The WebSocket close code that goes with each refusal (4000-4999 is the range for applications). The reason text is the same word. */
export const CLOSE_CODES: Record<RefusalReason | "browser_closed", number> = { unauthorized: 4401, viewer_in_use: 4409, released: 4410, bad_message: 4400, browser_closed: 4411 };

/** The viewer page, as three strings (viewer.ts): the server serves `html` at the page's path and `js` and `css` beside it, because the page's CSP
 *  is `default-src 'self'` and so allows no inline script or style. */
export type ViewerAssets = { html: string; js: string; css: string };

/** A frame is one binary message: the page's width and height in CSS pixels (two big-endian uint16), then the JPEG. */
export const FRAME_HEADER_BYTES = 4;
export function encodeFrame(jpeg: Uint8Array, w: number, h: number): Buffer {
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + jpeg.byteLength);
  out.writeUInt16BE(Math.min(w, 0xffff), 0);
  out.writeUInt16BE(Math.min(h, 0xffff), 2);
  out.set(jpeg, FRAME_HEADER_BYTES);
  return out;
}
export function decodeFrame(message: Uint8Array): { w: number; h: number; jpeg: Uint8Array } | null {
  if (message.byteLength <= FRAME_HEADER_BYTES) return null;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  return { w: view.getUint16(0), h: view.getUint16(2), jpeg: message.subarray(FRAME_HEADER_BYTES) };
}

/** What stream.ts gives the server: one session's page, shown and driven over its browser's DevTools socket. */
export type StreamHandlers = {
  /** The latest frame only. `ack` tells the browser to send the next: call it after the frame was sent to the viewer, or at once to drop it
   *  (the viewer is slow). No frame is kept after the handler returns, and none is ever written anywhere. */
  frame(jpeg: Buffer, page: { w: number; h: number }, ack: () => void): void;
  page(page: { url: string; title: string }): void;
  dialog(dialog: { kind: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string } | null): void;
  /** The browser's socket ended and was not asked to. */
  closed(): void;
};
export type Stream = {
  input(message: InputMessage): Promise<void>;
  nav(message: NavMessage): Promise<void>;
  dialog(answer: DialogAnswer): Promise<void>;
  close(): void;
};
/** Starts a stream on the browser at `cdpUrl` (its browser-level DevTools WebSocket). It follows the active page. */
export type StreamFactory = (cdpUrl: string, handlers: StreamHandlers) => Stream;


/** Caps on what a viewer may send, so a token holder cannot make the server or the page do unbounded work. */
/** Counted in characters, and chosen so that a message at its limit still fits the 64 KiB a connection allows (UTF-8 is at most 4 bytes a character). */
export const LIMITS = { text: 12 * 1024, url: 4 * 1024, coordinate: 65_535, wheel: 100_000, key: 64, promptText: 4 * 1024 } as const;

const finite = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;
const word = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
/** A string that may be empty: a key's `code` is, from a bare CDP key, a virtual keyboard or an IME. */
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const mods = (v: unknown): v is number | undefined => v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 15);

/** The address a viewer may send a page to: http(s) and about:blank. Never file:, chrome:, javascript:, data: or any other scheme. */
export function viewerMayOpen(raw: string): boolean {
  if (raw === "about:blank") return true;
  try { const u = new URL(raw); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; }
}

/** One text message from a viewer, checked field by field; null for anything that is not exactly a message of this protocol. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let m: any;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  switch (m.type) {
    case "hello": return word(m.token, 256) ? { type: "hello", token: m.token } : null;
    case "mouse":
      if (!["move", "down", "up"].includes(m.action) || !finite(m.x, LIMITS.coordinate) || !finite(m.y, LIMITS.coordinate) || !mods(m.modifiers)) return null;
      if (m.button !== undefined && !["left", "middle", "right"].includes(m.button)) return null;
      if (m.buttons !== undefined && !(Number.isInteger(m.buttons) && m.buttons >= 0 && m.buttons <= 31)) return null;
      if (m.clickCount !== undefined && !(Number.isInteger(m.clickCount) && m.clickCount >= 0 && m.clickCount <= 3)) return null;
      return { type: "mouse", action: m.action, x: m.x, y: m.y, ...(m.button ? { button: m.button } : {}), ...(m.buttons !== undefined ? { buttons: m.buttons } : {}), ...(m.clickCount !== undefined ? { clickCount: m.clickCount } : {}), ...(m.modifiers !== undefined ? { modifiers: m.modifiers } : {}) };
    case "wheel":
      if (!finite(m.x, LIMITS.coordinate) || !finite(m.y, LIMITS.coordinate) || !finite(m.deltaX, LIMITS.wheel) || !finite(m.deltaY, LIMITS.wheel) || !mods(m.modifiers)) return null;
      return { type: "wheel", x: m.x, y: m.y, deltaX: m.deltaX, deltaY: m.deltaY, ...(m.modifiers !== undefined ? { modifiers: m.modifiers } : {}) };
    case "key":
      if (!["down", "up"].includes(m.action) || !word(m.key, LIMITS.key) || !bounded(m.code, LIMITS.key) || !mods(m.modifiers)) return null;
      if (m.text !== undefined && (typeof m.text !== "string" || m.text.length > LIMITS.key)) return null;
      if (m.windowsVirtualKeyCode !== undefined && !(Number.isInteger(m.windowsVirtualKeyCode) && m.windowsVirtualKeyCode >= 0 && m.windowsVirtualKeyCode <= 0xffff)) return null;
      return { type: "key", action: m.action, key: m.key, code: m.code, ...(m.text !== undefined ? { text: m.text } : {}), ...(m.windowsVirtualKeyCode !== undefined ? { windowsVirtualKeyCode: m.windowsVirtualKeyCode } : {}), ...(m.modifiers !== undefined ? { modifiers: m.modifiers } : {}) };
    case "text": return typeof m.text === "string" && m.text.length > 0 && m.text.length <= LIMITS.text ? { type: "text", text: m.text } : null;
    case "nav":
      if (m.action === "back" || m.action === "reload") return { type: "nav", action: m.action };
      return m.action === "url" && word(m.url, LIMITS.url) && viewerMayOpen(m.url) ? { type: "nav", action: "url", url: m.url } : null;
    case "dialog":
      if (typeof m.accept !== "boolean" || (m.promptText !== undefined && (typeof m.promptText !== "string" || m.promptText.length > LIMITS.promptText))) return null;
      return { type: "dialog", accept: m.accept, ...(m.promptText !== undefined ? { promptText: m.promptText } : {}) };
    default: return null;
  }
}
