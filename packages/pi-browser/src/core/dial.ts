// The one way a CDP socket is opened from an AttachTarget: its dial URL with its headers (a relay's capability) when it has
// them, its driver URL otherwise. A dial's address and headers carry credentials, so no error names more than the host, and
// a dial whose credential ends (`expiresAt`) is closed at that moment.
import { randomUUID } from "node:crypto";
import type { AttachTarget } from "./host.js";

type Dialable = Pick<AttachTarget, "sdkCdpUrl" | "dial">;

export const dialUrl = (target: Dialable): string => target.dial?.url ?? target.sdkCdpUrl;

/** A driver URL no browser can dial, for a target whose browser has no URL of its own (a relay that needs a header the
 *  browser cannot send). Unique per call, so a binding keyed on one never catches another session's socket; a driver
 *  refuses such a target by this marker, never by guessing from its headers. */
const PLACEHOLDER = "ws://127.0.0.1:1/no-browser-url/";
export const placeholderUrl = (id: string): string => `${PLACEHOLDER}${encodeURIComponent(id)}/${randomUUID()}`;
export const isPlaceholder = (url: string): boolean => typeof url === "string" && url.startsWith(PLACEHOLDER);

/** A URL's host, for messages: never its path, query or userinfo. */
function hostOf(url: string): string {
  try { return new URL(url).host || "an unnamed host"; } catch { return "an unreadable address"; }
}

export function openDial(target: Dialable): WebSocket {
  const url = dialUrl(target);
  const expiresAt = target.dial?.expiresAt;
  if (expiresAt !== undefined && !(expiresAt > Date.now())) throw new Error(`the CDP dial to ${hostOf(url)} has expired`);
  const headers = target.dial?.headers;
  let socket: WebSocket;
  try {
    // Node's WebSocket (undici) takes its headers in an init object.
    socket = headers ? new (WebSocket as unknown as new (url: string, init: object) => WebSocket)(url, { headers: { ...headers } }) : new WebSocket(url);
  } catch {
    throw new Error(`the CDP socket to ${hostOf(url)} could not be opened`);
  }
  if (expiresAt !== undefined) {
    const deadline = setTimeout(() => socket.close(), Math.max(0, expiresAt - Date.now()));
    deadline.unref?.();
    socket.addEventListener("close", () => clearTimeout(deadline), { once: true });
  }
  return socket;
}
