// Capture and restore of a local Chrome's signed-in state over the browser's own DevTools websocket, from the harness side: never through the
// page facade, never reachable by a model. What is captured is what the host's allowed origins would be sent: the cookies by domain, and
// each origin's localStorage. It stays in memory and goes to the host's vault port; nothing here logs or returns a value.
// Local storage needs a frame on its origin: a short-lived target is made at the origin and every request it makes is answered locally
// (Fetch.fulfillRequest with an empty document), so nothing goes to the network and no script of the site runs.
import { clampSessionCookieAgeMs, cookieKept, vaultOrigins, type CapturedState, type VaultCookie } from "../core/vault.js";

export interface CdpLink {
  send(method: string, params?: object, sessionId?: string): Promise<any>;
  on(listener: (event: { method?: string; params?: any; sessionId?: string }) => void): () => void;
  close(): void;
}

/** One websocket to the browser (its `sdkCdpUrl`). */
export async function connectCdp(url: string, timeoutMs = 10_000): Promise<CdpLink> {
  const socket = new WebSocket(url);
  // A socket nobody receives is closed: a handshake that finishes after the deadline, or a setup that fails, leaves no connection open.
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the browser did not open its DevTools socket")), timeoutMs);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("the browser's DevTools socket failed")); };
    });
  } catch (error) { try { socket.close(); } catch { /* already closed */ } throw error; }
  let next = 0;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(event: any) => void>();
  socket.onmessage = (message) => {
    let data: any;
    try { data = JSON.parse(String(message.data)); } catch { return; }
    if (data.id !== undefined && waiting.has(data.id)) {
      const wait = waiting.get(data.id)!; waiting.delete(data.id);
      if (data.error) wait.reject(new Error(String(data.error.message ?? "refused"))); else wait.resolve(data.result);
    } else for (const listener of listeners) listener(data);
  };
  socket.onclose = () => { for (const wait of waiting.values()) wait.reject(new Error("the DevTools socket closed")); waiting.clear(); };
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`the browser did not answer ${method}`)); }, 15_000);
      waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
    on: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    close: () => socket.close(),
  };
}

const EMPTY_DOCUMENT = btoa("<!doctype html><title></title>");
const PATH = "/__pi-browser-vault__";

/** Runs `use` with a session on a page at `origin` whose every request to that origin was answered locally. */
async function atOrigin<T>(link: CdpLink, origin: string, use: (send: (method: string, params?: object) => Promise<any>) => Promise<T>): Promise<T> {
  const { targetId } = await link.send("Target.createTarget", { url: "about:blank" });
  try {
    const { sessionId } = await link.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method: string, params?: object) => link.send(method, params, sessionId);
    const stop = link.on((event) => {
      if (event.sessionId === sessionId && event.method === "Fetch.requestPaused") {
        void send("Fetch.fulfillRequest", { requestId: event.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }], body: EMPTY_DOCUMENT }).catch(() => undefined);
      }
    });
    try {
      await send("Page.enable");
      await send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/*` }] });
      const loaded = new Promise<void>((resolve) => { const off = link.on((event) => { if (event.sessionId === sessionId && event.method === "Page.loadEventFired") { off(); resolve(); } }); setTimeout(() => { off(); resolve(); }, 8000); });
      await send("Page.navigate", { url: `${origin}${PATH}` });
      await loaded;
      await send("DOMStorage.enable");
      return await use(send);
    } finally { stop(); }
  } finally { await link.send("Target.closeTarget", { targetId }).catch(() => undefined); }
}

const toVaultCookie = (cookie: any): VaultCookie => ({
  name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path ?? "/",
  ...(cookie.session || !(cookie.expires > 0) ? {} : { expires: cookie.expires }),
  httpOnly: cookie.httpOnly === true, secure: cookie.secure === true,
  ...(cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None" ? { sameSite: cookie.sameSite } : {}),
});

/** The allowed origins' cookies and local storage, now. The cookies filtered to the origins before they leave this function. */
export async function captureCdpState(link: CdpLink, origins: readonly string[], now: Date = new Date()): Promise<Extract<CapturedState, { kind: "cdp" }>> {
  const allowed = vaultOrigins(origins);
  const { cookies } = await link.send("Storage.getCookies", {});
  const kept = (cookies as any[]).filter((cookie) => cookieKept(cookie, allowed)).map(toVaultCookie);
  const localStorage: Record<string, Record<string, string>> = {};
  for (const origin of allowed) {
    const entries = await atOrigin(link, origin, async (send) => (await send("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: origin, isLocalStorage: true } })).entries as [string, string][]);
    if (entries.length) localStorage[origin] = Object.fromEntries(entries);
  }
  return { kind: "cdp", capturedAt: now.toISOString(), cookies: kept, localStorage };
}

export type RestoreCounts = { cookies: number; origins: number; droppedExpired: number; droppedAged: number; droppedOutside: number };

/** Puts a captured state into a browser that has opened no page yet: cookies first (browser level), then each origin's local storage. Only what
 *  the requested origins allow is put back, and a cookie is dropped when it expired, or is a session cookie older than the age cap. Returns counts only. */
export async function restoreCdpState(link: CdpLink, state: Extract<CapturedState, { kind: "cdp" }>, origins: readonly string[], now: Date = new Date(), maxSessionCookieAgeMs?: number): Promise<RestoreCounts> {
  const allowed = vaultOrigins(origins);
  const cap = clampSessionCookieAgeMs(maxSessionCookieAgeMs);
  const counts: RestoreCounts = { cookies: 0, origins: 0, droppedExpired: 0, droppedAged: 0, droppedOutside: 0 };
  const capturedAt = Date.parse(state.capturedAt);
  const params: object[] = [];
  for (const cookie of state.cookies) {
    if (!cookieKept(cookie, allowed)) { counts.droppedOutside += 1; continue; }
    if (cookie.expires !== undefined) { if (cookie.expires * 1000 <= now.getTime()) { counts.droppedExpired += 1; continue; } }
    else if (!Number.isFinite(capturedAt) || now.getTime() - capturedAt > cap) { counts.droppedAged += 1; continue; }
    params.push({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}), ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}) });
  }
  if (params.length) await link.send("Storage.setCookies", { cookies: params });
  counts.cookies = params.length;
  for (const origin of allowed) {
    const items = state.localStorage[origin];
    if (!items || !Object.keys(items).length) continue;
    await atOrigin(link, origin, async (send) => { for (const [key, value] of Object.entries(items)) await send("DOMStorage.setDOMStorageItem", { storageId: { securityOrigin: origin, isLocalStorage: true }, key, value }); });
    counts.origins += 1;
  }
  for (const origin of Object.keys(state.localStorage)) if (!allowed.includes(origin)) counts.droppedOutside += 1;
  return counts;
}
