import { browserbaseHoldings } from "./shared.js";

export { directFetch, closeDirectFetch } from "./http.js";

/** Rewrite a Browserbase connect URL onto the credential proxy: only `*.browserbase.com` hosts, the signing query kept. */
export function rewriteConnectUrl(connectUrl: string, connectBaseUrl: string | undefined | null): string {
  if (!connectUrl || !connectBaseUrl) return connectUrl;
  try {
    const target = new URL(connectBaseUrl);
    const u = new URL(connectUrl);
    if (!/(?:^|\.)browserbase\.com$/i.test(u.hostname)) return connectUrl;
    u.protocol = target.protocol;
    u.host = target.host;
    u.pathname = target.pathname.replace(/\/$/, "") + u.pathname;
    return u.toString();
  } catch {
    return connectUrl;
  }
}

/** Direct, never through the HTTP(S) env proxy: it rejects CONNECT and the CDP WebSocket cannot ride it. Under `node
 *  --use-env-proxy` NO_PROXY is re-read per request, so listing these hosts bypasses it. */
export function browserbaseNoProxyHosts(env: NodeJS.ProcessEnv): string[] {
  const hosts = new Set<string>();
  for (const key of ["BROWSERBASE_BASE_URL", "BROWSERBASE_CONNECT_BASE_URL"]) {
    const raw = String(env[key] || "").trim();
    if (!raw) continue;
    try { hosts.add(new URL(raw).hostname); } catch {}
  }
  if (!String(env.BROWSERBASE_CONNECT_BASE_URL || "").trim()) hosts.add(".browserbase.com");
  return [...hosts];
}

export function applyBrowserbaseNoProxy(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = browserbaseNoProxyHosts(env);
  if (!hosts.length) return hosts;
  for (const target of env === process.env ? [env] : [env, process.env]) {
    for (const key of ["NO_PROXY", "no_proxy"]) {
      const merged = String(target[key] || "").split(",").map((h) => h.trim()).filter(Boolean);
      for (const h of hosts) if (!merged.includes(h)) merged.push(h);
      target[key] = merged.join(",");
    }
  }
  return hosts;
}

/** The driver keeps the raw connect URL (the extension in the cloud browser dials it back and reaches only
 *  Browserbase); this process's socket dials the proxy, so the rewrite happens at dial time, never in a record. */
/** Per-socket targets, so two providers with different proxies never send one's signed URL to the other's proxy. */
const { boundDials } = browserbaseHoldings;
/** A second provider binding the same URL to a different proxy is refused, never switched: the signed URL would go to
 *  it. */
export function bindConnectDial(connectUrl: string, connectBaseUrl: string | null): void {
  const target = connectBaseUrl?.trim() ?? "";
  const bound = boundDials.get(connectUrl);
  if (bound !== undefined && bound !== target) throw new Error("this Browserbase session is already attached through another credential proxy");
  boundDials.set(connectUrl, target);
}
export function unbindConnectDial(connectUrl: string): void {
  boundDials.delete(connectUrl);
  if (![...boundDials.values()].some(Boolean)) restoreWebSocket();
}
export function connectDialUrl(url: string): string {
  const bound = boundDials.get(url);
  if (bound !== undefined) return bound ? rewriteConnectUrl(url, bound) : url;
  return url;
}

/** Wraps the process WebSocket only while a session is bound to a proxy; the native one returns with the last binding. A wrapper
 *  installed on top cannot be removed, so ours stays under it and, with no bindings, passes every URL through. */
let wrapped: { original: any; wrapper: any } | null = null;
export function installWebSocketWrapper(): void {
  if (typeof (globalThis as any).WebSocket !== "function" || (wrapped && (globalThis as any).WebSocket === wrapped.wrapper)) return;
  const original = (globalThis as any).WebSocket;
  const wrapper = function (this: any, url: any, protocols?: any) { return new original(connectDialUrl(String(url)), protocols); } as any;
  wrapper.prototype = original.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) wrapper[k] = original[k];
  (globalThis as any).WebSocket = wrapper;
  wrapped = { original, wrapper };
}

function restoreWebSocket(): void {
  if (!wrapped || (globalThis as any).WebSocket !== wrapped.wrapper) return;
  (globalThis as any).WebSocket = wrapped.original;
  wrapped = null;
}
