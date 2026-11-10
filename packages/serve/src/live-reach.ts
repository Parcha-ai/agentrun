// A live viewer on a runner on another host than its server (one image, a server and its runners apart). The runner says
// where it answers (AGENTRUN_RUNNER_LIVE_HOST: a host name or IPv4 address the server reaches it at; the viewers listen
// on AGENTRUN_RUNNER_LIVE_BIND, that host by default) and puts that host in each viewer's row. The server dials a row's
// host only when it is one of its runners' (AGENTRUN_RUNNER_HOSTS, a comma list), else the row reads as no viewer: a
// store writer that is no runner can't aim the server's socket elsewhere. Each request the server makes of a runner's
// viewer (the HEAD that asks whether it answers, and the proxied WebSocket) carries the proxy's proof: an HMAC of the
// viewer's id and the time, under a key derived from the seal key the server and its runners already share. A runner's
// endpoint off loopback takes no request without a good, fresh proof for its own viewer. The proof is not the viewer's:
// the hello's token still decides who watches. The hop is plain HTTP, for a private network (the server and its
// runners' own); TLS on it is a later step.
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** The header the proxy's proof travels in. */
export const LIVE_PROOF_HEADER = "x-agentrun-live";
/** How far a proof's time may be from the endpoint's clock. */
export const LIVE_PROOF_MS = 60_000;
/** A host a row may name: a DNS name or an IPv4 address, nothing with a port, a path or a scheme. */
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/** Where every viewer answers when its runner is on the server's own machine. */
export const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the address a viewer on the server's own machine answers at
/** The derived key's label: the seal key itself is never a MAC key. */
const LABEL = "agentrun live proxy v1";

export const isLiveHost = (host: unknown): host is string => typeof host === "string" && HOST.test(host);

const proofKey = (sealKey: Buffer): Buffer => Buffer.from(hkdfSync("sha256", sealKey, Buffer.alloc(0), LABEL, 32));
const mac = (key: Buffer, viewerId: string, at: number): string => createHmac("sha256", key).update(`${viewerId}\n${at}`).digest("hex");

/** What the server needs to reach a runner's viewer: the hosts it dials (its runners'), and the proof's key. */
export type LiveReach = { readonly hosts: ReadonlySet<string>; readonly key: Buffer };

/** The server's reach, from its environment (AGENTRUN_RUNNER_HOSTS) and the seal key. A name that is not a host is left
 *  out. */
export function liveReachOf(env: { readonly AGENTRUN_RUNNER_HOSTS?: string | undefined }, sealKey: Buffer): LiveReach {
  const hosts = new Set((env.AGENTRUN_RUNNER_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(isLiveHost));
  return { hosts, key: proofKey(sealKey) };
}

/** Where the server dials `host` (a row's): loopback with none; the host when it is one of its runners'; else nowhere. */
export function dialHost(host: string | undefined, reach: LiveReach | undefined): string | undefined {
  if (host === undefined || host === LOOPBACK) return LOOPBACK;
  return reach?.hosts.has(host.toLowerCase()) ? host : undefined;
}

/** The proxy's proof for viewer `viewerId`, at `at` (ms). */
export const liveProof = (reach: Pick<LiveReach, "key">, viewerId: string, at: number = Date.now()): string => `${at}.${mac(reach.key, viewerId, at)}`;

/** Where a runner's viewers answer: the host the server reaches it at (put in each row), the address they listen on,
 *  and the proof's key. */
export type RunnerLive = { readonly host: string; readonly bind: string; readonly key: Buffer };

/** The runner's live host, from its environment (AGENTRUN_RUNNER_LIVE_HOST, AGENTRUN_RUNNER_LIVE_BIND) and the seal key;
 *  undefined with none (or one that is not a host): its viewers answer on loopback, as on a server's own machine. */
export function runnerLiveOf(env: { readonly AGENTRUN_RUNNER_LIVE_HOST?: string | undefined; readonly AGENTRUN_RUNNER_LIVE_BIND?: string | undefined }, sealKey: Buffer): RunnerLive | undefined {
  const host = env.AGENTRUN_RUNNER_LIVE_HOST?.trim();
  if (!isLiveHost(host) || host === LOOPBACK) return undefined;
  const bind = env.AGENTRUN_RUNNER_LIVE_BIND?.trim();
  return { host, bind: bind && (isLiveHost(bind) || bind === "0.0.0.0") ? bind : host, key: proofKey(sealKey) };
}

/** Whether `req` carries a good, fresh proof for viewer `viewerId` under `live`'s key. */
export function provenFor(req: Pick<IncomingMessage, "headers">, live: Pick<RunnerLive, "key">, viewerId: string, now: number = Date.now()): boolean {
  const said = req.headers[LIVE_PROOF_HEADER];
  const match = typeof said === "string" ? /^(\d{1,16})\.([0-9a-f]{64})$/.exec(said) : null;
  if (!match) return false;
  const at = Number(match[1]);
  if (!Number.isSafeInteger(at) || Math.abs(now - at) > LIVE_PROOF_MS) return false;
  const want = Buffer.from(mac(live.key, viewerId, at), "hex");
  const got = Buffer.from(match[2]!, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}
