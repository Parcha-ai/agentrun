// A live viewer on a runner on another host than its server (one image, a server and its runners apart). The runner says
// where it answers (AGENTRUN_RUNNER_LIVE_HOST: a host name or IPv4 address the server reaches it at; the viewers listen
// on AGENTRUN_RUNNER_LIVE_BIND, that host by default) and puts that host in each viewer's row. The server dials a row's
// host only when it is one of its runners' (AGENTRUN_RUNNER_HOSTS, a comma list), else the row reads as no viewer: a
// store writer that is no runner can't aim the server's socket elsewhere. Each request the server makes of a runner's
// viewer (the HEAD that asks whether it answers, and the proxied WebSocket) carries the proxy's proof: an HMAC of the
// viewer's id and the time, under the viewer's run's key (reachForRun, liveForRun), derived from a key derived from the
// seal key the server and its runners already share. A runner's
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
export const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule where a viewer on the same machine as its server answers
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
  // Lower case, as a URL's hostname reads a DNS name and the server's runners' hosts are read (liveReachOf): one form for
  // the links, the origins and the rows.
  const host = env.AGENTRUN_RUNNER_LIVE_HOST?.trim().toLowerCase();
  if (!isLiveHost(host) || host === LOOPBACK) return undefined;
  const bind = env.AGENTRUN_RUNNER_LIVE_BIND?.trim().toLowerCase();
  return { host, bind: bind && (isLiveHost(bind) || bind === "0.0.0.0") ? bind : host, key: proofKey(sealKey) };
}

/** A run's own proof key, from the runners' shared one: what proves a request for one run's viewers and no other's. A
 *  run's own process is handed its run's (held.ts liveAt), never the shared key, so it can open no other run's viewer. */
const runKey = (key: Buffer, runId: string): Buffer => createHmac("sha256", key).update(`${RUN_LABEL}\n${runId}`).digest();
/** The run label of runKey: another MAC than the proof's own. */
const RUN_LABEL = "agentrun live run v1";

/** The server's reach for run `runId`'s viewers: its hosts, under that run's key. */
export const reachForRun = (reach: LiveReach, runId: string): LiveReach => ({ hosts: reach.hosts, key: runKey(reach.key, runId) });

/** A runner's live address for run `runId`'s viewers: its host and bind, under that run's key. */
export const liveForRun = (live: RunnerLive, runId: string): RunnerLive => ({ host: live.host, bind: live.bind, key: runKey(live.key, runId) });

/** Whether `req` carries a good, fresh proof for viewer `viewerId` under `live`'s key: its time within `windowMs` of
 *  the endpoint's clock (LIVE_PROOF_MS by default). */
export function provenFor(req: Pick<IncomingMessage, "headers">, live: Pick<RunnerLive, "key">, viewerId: string, now: number = Date.now(), windowMs: number = LIVE_PROOF_MS): boolean {
  const said = req.headers[LIVE_PROOF_HEADER];
  const match = typeof said === "string" ? /^(\d{1,16})\.([0-9a-f]{64})$/.exec(said) : null;
  if (!match) return false;
  const at = Number(match[1]);
  if (!Number.isSafeInteger(at) || Math.abs(now - at) > windowMs) return false;
  const want = Buffer.from(mac(live.key, viewerId, at), "hex");
  const got = Buffer.from(match[2]!, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

// A dial relayed to its runner (dial-relay.ts): a machine a runner in a process of its own made dials the server's
// attach route, and the server proxies its socket to that runner's attach listener with the same proof, under the same
// key, over a subject of its own. The subject binds the machine's token (its SHA-256), the runner the token's row names
// and that runner's incarnation (its process since its start), so a proof opens that one token's socket on that one
// runner and nowhere else. Its window is RELAY_PROOF_MS, and the runner takes each proof once (relayProofs).

/** How far a relay's proof's time may be from the runner's clock: the one hop's time, and no more. */
export const RELAY_PROOF_MS = 10_000;

/** What a relay's proof binds: the machine's token (its SHA-256), the runner its row names, and that runner's
 *  incarnation. A viewer's id has no newline, so no relay subject is ever a viewer's. */
export type RelayTo = { readonly tokenSha256: string; readonly runner: string; readonly incarnation: string };
const relaySubject = (to: RelayTo): string => `attach relay\n${to.tokenSha256}\n${to.runner}\n${to.incarnation}`;

/** The server's proof for relaying the dial of token `to.tokenSha256` to runner `to.runner`, at `at` (ms). */
export const relayProof = (reach: Pick<LiveReach, "key">, to: RelayTo, at: number = Date.now()): string => liveProof(reach, relaySubject(to), at);

/** The proof's key, from the seal key, for a runner's attach listener (whatever host it answers on). */
export const relayKeyOf = (sealKey: Buffer): Pick<LiveReach, "key"> => ({ key: proofKey(sealKey) });

/** A runner's check of the relay's proofs: good, fresh (RELAY_PROOF_MS) and for `to`, and never one it took before, so
 *  a proof read off the hop opens no second socket. */
export function relayProofs(live: Pick<LiveReach, "key">, now: () => number = Date.now): (req: Pick<IncomingMessage, "headers">, to: RelayTo) => boolean {
  const taken = new Map<string, number>();
  return (req, to) => {
    const at = now();
    for (const [proof, until] of taken) if (until < at) taken.delete(proof);
    const said = req.headers[LIVE_PROOF_HEADER];
    if (typeof said !== "string" || taken.has(said) || !provenFor(req, live, relaySubject(to), at, RELAY_PROOF_MS)) return false;
    taken.set(said, at + 2 * RELAY_PROOF_MS);
    return true;
  };
}
