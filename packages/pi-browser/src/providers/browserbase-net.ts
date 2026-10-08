// The Browserbase network lane: where the process's HTTP and WebSocket traffic to Browserbase goes, and how.
import nodeModule from "node:module";
import type * as Undici from "undici";

const require = nodeModule.createRequire(import.meta.url);
let undiciModule: typeof Undici | undefined;
/** Userland undici, loaded on the first call that needs it (an optional peer: a process that never reaches Browserbase never loads it). */
const undiciDoor = (): typeof Undici => (undiciModule ??= require("undici") as typeof Undici);

/** Rewrite a Browserbase connect URL onto the credential proxy. Only `*.browserbase.com` hosts are
 *  rewritten (a proxy-issued URL passes through); the target's path becomes a prefix, and the
 *  signing query survives because we mutate a URL object. */
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

/** The Browserbase lane is DIRECT: the credential proxy (or Browserbase itself) is reached over the
 *  sandbox's own tailnet/egress, never through the HTTP(S) env proxy: that proxy is a signing hop
 *  that rejects CONNECT by design, and the CDP WebSocket cannot ride it. A process under
 *  `node --use-env-proxy` re-reads NO_PROXY per request, so listing the lane's hosts there bypasses
 *  the proxy for both the REST calls and the WebSocket. */
export function browserbaseNoProxyHosts(env: NodeJS.ProcessEnv): string[] {
  const hosts = new Set<string>();
  for (const key of ["BROWSERBASE_BASE_URL", "BROWSERBASE_CONNECT_BASE_URL"]) {
    const raw = String(env[key] || "").trim();
    if (!raw) continue;
    try { hosts.add(new URL(raw).hostname); } catch { /* not a URL: nothing to bypass */ }
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

/** One plain agent for every direct call in the process: REST calls go direct, never through the env proxy, and connections
 *  are reused instead of one agent per client. `closeDirectFetch` ends it (the next call makes a new one). */
let directAgent: any;
export async function directFetch(): Promise<((input: any, init?: any) => Promise<any>) | undefined> {
  try {
    const undici: any = undiciDoor();
    // Userland undici refuses a request body it must stream (the extension upload's multipart file) without `duplex`.
    return (input: any, init: any = {}) => undici.fetch(input, { ...init, dispatcher: (directAgent ??= new undici.Agent()), ...(init.body ? { duplex: "half" } : {}) });
  } catch {
    return undefined;
  }
}
export async function closeDirectFetch(): Promise<void> {
  const agent = directAgent;
  directAgent = undefined;
  await agent?.close();
}

/** Where the process's CDP WebSocket goes. The URL the driver holds stays Browserbase's raw connect URL, because the
 *  driver extension inside the cloud browser dials that same URL back from Browserbase's side and can only reach
 *  Browserbase's own host; the process's socket, on a lane where Browserbase is only reachable through the credential
 *  proxy, goes to the connect base. The rewrite therefore happens at DIAL time, in the WebSocket wrapper, never in a
 *  session record. */
/** Per-socket targets, so two providers with different proxies in one process never send one's signed URL to the other's
 *  proxy. Keyed by the exact connect URL; the empty string means "dial it as it is". */
const boundDials = new Map<string, string>();
/** A session's URL is bound to one proxy. A second provider binding the same URL to a different one is refused, never
 *  switched: the first provider's sockets would otherwise send the signed URL to the second one's proxy. */
export function bindConnectDial(connectUrl: string, connectBaseUrl: string | null): void {
  const target = connectBaseUrl?.trim() ?? "";
  const bound = boundDials.get(connectUrl);
  if (bound !== undefined && bound !== target) throw new Error("this Browserbase session is already attached through another credential proxy");
  boundDials.set(connectUrl, target);
}
export function unbindConnectDial(connectUrl: string): void { boundDials.delete(connectUrl); }
export function connectDialUrl(url: string): string {
  const bound = boundDials.get(url);
  if (bound !== undefined) return bound ? rewriteConnectUrl(url, bound) : url;
  return url;
}

/** The process WebSocket wrapper: a socket opened on a connect URL that a provider bound to a credential proxy dials the
 *  proxy instead. Process-wide, installed once. */
let wsWrapped = false;
export function installWebSocketWrapper(): void {
  if (wsWrapped || typeof (globalThis as any).WebSocket !== "function") return;
  const Original = (globalThis as any).WebSocket;
  const Wrapped = function (this: any, url: any, protocols?: any) { return new Original(connectDialUrl(String(url)), protocols); } as any;
  Wrapped.prototype = Original.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Wrapped[k] = Original[k];
  (globalThis as any).WebSocket = Wrapped;
  wsWrapped = true;
}
