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
//
// Runners that are replicas of one deployment (Kubernetes pods, a platform's instances) have no host name of their own
// the server resolves, and their addresses change at each start. For them both settings take an IPv4 block in CIDR form:
// a runner whose AGENTRUN_RUNNER_LIVE_HOST is a block answers at its own address in that block (its one network
// interface address there), and a server whose AGENTRUN_RUNNER_HOSTS lists a block dials any IPv4 address in it. The
// block is the private network the runners' addresses come from (a cluster's pod range), and the proof above still
// guards every request on it.
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";

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

/** An IPv4 block, `a.b.c.d/n`: its network address as a 32-bit number and its prefix length. */
export type Ipv4Block = { readonly base: number; readonly bits: number };
/** The shortest prefix a block may have: a /8 is a whole private range, and anything wider is no runners' network. */
export const MIN_BLOCK_BITS = 8;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** `address` (dotted IPv4, no leading zeros) as a 32-bit number, or undefined. */
export function ipv4Of(address: string): number | undefined {
  const match = IPV4.exec(address);
  return match ? match.slice(1).reduce((sum, octet) => sum * 256 + Number(octet), 0) : undefined;
}

const maskOf = (bits: number): number => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

/** `value` as an IPv4 block: its address the block's network address (no host bits set) and its prefix from
 *  MIN_BLOCK_BITS to 32; else undefined. */
export function ipv4BlockOf(value: string): Ipv4Block | undefined {
  const match = /^([0-9.]+)\/(\d{1,2})$/.exec(value);
  if (!match) return undefined;
  const base = ipv4Of(match[1]!);
  const bits = Number(match[2]);
  if (base === undefined || bits < MIN_BLOCK_BITS || bits > 32 || ((base & ~maskOf(bits)) >>> 0) !== 0) return undefined;
  return { base, bits };
}

/** Whether IPv4 `address` is in `block`. */
export const inBlock = (address: number, block: Ipv4Block): boolean => ((address & maskOf(block.bits)) >>> 0) === block.base;

/** What the server needs to reach a runner's viewer: the hosts it dials (its runners'), the IPv4 blocks whose every
 *  address it dials (its runners' network), and the proof's key. */
export type LiveReach = { readonly hosts: ReadonlySet<string>; readonly blocks: readonly Ipv4Block[]; readonly key: Buffer };

/** The server's reach, from its environment (AGENTRUN_RUNNER_HOSTS: host names, IPv4 addresses and IPv4 blocks) and
 *  the seal key. An entry that is none of them is left out. */
export function liveReachOf(env: { readonly AGENTRUN_RUNNER_HOSTS?: string | undefined }, sealKey: Buffer): LiveReach {
  const entries = (env.AGENTRUN_RUNNER_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase());
  const hosts = new Set(entries.filter(isLiveHost));
  const blocks = entries.map(ipv4BlockOf).filter((block): block is Ipv4Block => block !== undefined);
  return { hosts, blocks, key: proofKey(sealKey) };
}

/** Where the server dials `host` (a row's): loopback with none; the host when it is one of its runners' or an IPv4
 *  address in one of their blocks; else nowhere. */
export function dialHost(host: string | undefined, reach: LiveReach | undefined): string | undefined {
  if (host === undefined || host === LOOPBACK) return LOOPBACK;
  if (reach === undefined) return undefined;
  if (reach.hosts.has(host.toLowerCase())) return host;
  const address = ipv4Of(host);
  return address !== undefined && reach.blocks.some((block) => inBlock(address, block)) ? host : undefined;
}

/** The proxy's proof for viewer `viewerId`, at `at` (ms). */
export const liveProof = (reach: Pick<LiveReach, "key">, viewerId: string, at: number = Date.now()): string => `${at}.${mac(reach.key, viewerId, at)}`;

/** Where a runner's viewers answer: the host the server reaches it at (put in each row), the address they listen on,
 *  and the proof's key. */
export type RunnerLive = { readonly host: string; readonly bind: string; readonly key: Buffer };

/** This machine's network interfaces, as node:os reads them: an injection point for tests. */
export type Interfaces = () => ReturnType<typeof networkInterfaces>;

/** A runner's live host it cannot take: its AGENTRUN_RUNNER_LIVE_HOST names a block that holds none, or more than one,
 *  of this machine's addresses. Thrown at the runner's start, so it never says it answers where the server cannot
 *  reach it. */
export class RunnerLiveRefused extends Error {
  override readonly name = "RunnerLiveRefused";
}

/** This machine's one IPv4 address in `block` (AGENTRUN_RUNNER_LIVE_HOST as a block, named `given`); refused in words
 *  with none or several. */
function ownAddressIn(block: Ipv4Block, given: string, interfaces: Interfaces): string {
  const found = new Set<string>();
  for (const addresses of Object.values(interfaces())) {
    for (const one of addresses ?? []) {
      const address = one.family === "IPv4" && !one.internal ? ipv4Of(one.address) : undefined;
      if (address !== undefined && inBlock(address, block)) found.add(one.address);
    }
  }
  if (found.size === 1) return [...found][0]!;
  throw new RunnerLiveRefused(found.size === 0
    ? `AGENTRUN_RUNNER_LIVE_HOST is ${given}, and no network interface of this machine has an IPv4 address in it: name the block this runner's address is in, or the host the server reaches it at`
    : `AGENTRUN_RUNNER_LIVE_HOST is ${given}, and this machine has ${found.size} IPv4 addresses in it (${[...found].sort().join(", ")}): name a narrower block, or the host the server reaches it at`);
}

/** The runner's live host, from its environment (AGENTRUN_RUNNER_LIVE_HOST, AGENTRUN_RUNNER_LIVE_BIND) and the seal key;
 *  undefined with none (or one that is not a host): its viewers answer on loopback, as on a server's own machine. An
 *  IPv4 block for a host is this machine's own address in it (refused, RunnerLiveRefused, with none or several). */
export function runnerLiveOf(env: { readonly AGENTRUN_RUNNER_LIVE_HOST?: string | undefined; readonly AGENTRUN_RUNNER_LIVE_BIND?: string | undefined }, sealKey: Buffer, interfaces: Interfaces = networkInterfaces): RunnerLive | undefined {
  // Lower case, as a URL's hostname reads a DNS name and the server's runners' hosts are read (liveReachOf): one form for
  // the links, the origins and the rows.
  const given = env.AGENTRUN_RUNNER_LIVE_HOST?.trim().toLowerCase();
  const block = given === undefined ? undefined : ipv4BlockOf(given);
  const host = block !== undefined ? ownAddressIn(block, given!, interfaces) : given;
  if (!isLiveHost(host) || host === LOOPBACK) return undefined;
  const bind = env.AGENTRUN_RUNNER_LIVE_BIND?.trim().toLowerCase();
  return { host, bind: bind && (isLiveHost(bind) || bind === "0.0.0.0") ? bind : host, key: proofKey(sealKey) };
}

/** A run's own proof key, from the runners' shared one: what proves a request for one run's viewers and no other's. A
 *  run's own process is handed its run's (held.ts liveAt), never the shared key, so it can open no other run's viewer. */
const runKey = (key: Buffer, runId: string): Buffer => createHmac("sha256", key).update(`${RUN_LABEL}\n${runId}`).digest();
/** The run label of runKey: another MAC than the proof's own. */
const RUN_LABEL = "agentrun live run v1";

/** The server's reach for run `runId`'s viewers: its hosts and blocks, under that run's key. */
export const reachForRun = (reach: LiveReach, runId: string): LiveReach => ({ hosts: reach.hosts, blocks: reach.blocks, key: runKey(reach.key, runId) });

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

/** How long the server waits for a runner's attach listener to take a relayed dial. */
export const RELAY_CONNECT_MS = 10_000;

/** What a relay's proof binds: the machine's token (its SHA-256), the runner its row names, and that runner's
 *  incarnation. A viewer's id has no newline, so no relay subject is ever a viewer's. */
export type RelayTo = { readonly tokenSha256: string; readonly runner: string; readonly incarnation: string };
const relaySubject = (to: RelayTo): string => `attach relay\n${to.tokenSha256}\n${to.runner}\n${to.incarnation}`;

/** The server's proof for relaying the dial of token `to.tokenSha256` to runner `to.runner`, at `at` (ms). */
export const relayProof = (reach: Pick<LiveReach, "key">, to: RelayTo, at: number = Date.now()): string => liveProof(reach, relaySubject(to), at);

/** The proof's key, from the seal key, for a runner's attach listener (whatever host it answers on). */
export const relayKeyOf = (sealKey: Buffer): Pick<LiveReach, "key"> => ({ key: proofKey(sealKey) });

/** A runner's check of the relay's proofs: good, fresh (RELAY_PROOF_MS) and for `to`, and never one it took before, so
 *  a proof read off the hop opens no second socket. A proof is taken once by its MAC, not by the header as sent: the
 *  time reads as a number, so `0<ms>.<mac>` is the same signed proof as `<ms>.<mac>`, while the MAC (lower-case hex
 *  only) has one spelling for each subject and time. */
export function relayProofs(live: Pick<LiveReach, "key">, now: () => number = Date.now): (req: Pick<IncomingMessage, "headers">, to: RelayTo) => boolean {
  const taken = new Map<string, number>();
  return (req, to) => {
    const at = now();
    for (const [proof, until] of taken) if (until < at) taken.delete(proof);
    const said = req.headers[LIVE_PROOF_HEADER];
    const signed = typeof said === "string" ? said.slice(said.indexOf(".") + 1) : undefined;
    if (signed === undefined || taken.has(signed) || !provenFor(req, live, relaySubject(to), at, RELAY_PROOF_MS)) return false;
    taken.set(signed, at + 2 * RELAY_PROOF_MS);
    return true;
  };
}
