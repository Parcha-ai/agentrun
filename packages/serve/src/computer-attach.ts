// A person's own computer paired with this server, the attach binding's server side (spec/computer/attach.md): the
// owner's pairing code (POST /v2/computers/pairings), the driver's trade of that code for its computer's token (POST
// /v2/computers/pair, which needs no token of the server's: the code is the credential), the attach socket the driver
// dials with that token (GET /v2/computers/attach, a WebSocket), the paired computers as GET /v2/computers lists them,
// and their removal (DELETE /v2/computers/{id}). The computer package's AttachHub holds each computer's live socket; this
// module checks who dials, wraps the WebSocket as the AttachSocket the hub takes, and keeps the store's rows.
//
// A code is good once for PAIRING_CODE_TTL_MS, and a token until its computer is removed: the store keeps the SHA-256 of
// each, never the value. A wrong, used or expired code is one answer, 404 with no word about which, and each source
// address gets PAIR_TRIES_PER_MINUTE tries a minute.
//
// A hosted machine that dials this server (a dial provider's, spec/computer/attach.md) is let in by the token its create
// minted (machineTokens), kept as its SHA-256 until the machine's backstop or its delete: its socket goes to the hub under
// the machine's name, and it fetches this server's computerd build with the same token (GET /v2/computers/daemon,
// DAEMON_FETCHES_PER_MINUTE a minute per machine).
//
// One process: the hub is this process's memory, so a run takes a paired computer only from a runner in the process
// that holds its socket (the CLI's start, with its runner beside the server). A runner of its own process refuses one in
// words (workspace/attached-computers.ts ONE_PROCESS_WORDS); a second server on the same store is refused at its start.
//
// A hosted machine a runner in a process of its own made (dial-relay.ts) dials this server the same way, and its token's
// row names that runner: the server relays its socket to the runner's attach listener (`relay`), where these same routes
// (`owner`, the runner's) take it into the runner's hub. The relay is two sockets, each with this module's limits (a frame
// over MAX_LINE_BYTES, a binary frame, ATTACH_IDLE_MS of silence), joined frame by frame: a close of either closes the
// other with its code.
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { ATTACH_CLOSE, ATTACH_HEARTBEAT_MS, ATTACH_IDLE_MS, ATTACH_PATH, ATTACH_SUBPROTOCOL, type AttachHub, type AttachSocket, type ComputerKind, type ComputerOs, type HelloResult, hostedDaemonPath, MAX_LINE_BYTES, type MachineTokens, mintedComputer, type PairedComputer, PAIRING_CODE_PATTERN, PAIRING_CODE_TTL_MS, PROTOCOL_VERSION, RUN_LABEL } from "@parcha/agentrun-computer";
import { WebSocket, WebSocketServer } from "ws";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { dialHost, LIVE_PROOF_HEADER, type LiveReach, relayProof } from "./live-reach.js";
import { peerKey } from "./owner.js";
import { registerNotSecretWrite } from "./secret-writes.js";
import type { MintedTokenRow, MintedTokens, PairedComputerRow, PairedComputers, RunnerRelays } from "./store/index.js";
import { pairedOf, PAIRED_ID_PREFIX, RUNNER_APART_WORDS, servesNoKind } from "./workspace/attached-computers.js";

// Routes under /computers, where a provider's keys are a secret write (computers.ts): these three write none of the
// owner's secrets, so the API token may call them as the console's session does.
registerNotSecretWrite("createPairing", "A pairing code is shown once and kept as its hash: it is a one-time code, not a secret of the owner's.");
registerNotSecretWrite("pairComputer", "The driver trades a pairing code for its own computer's token; nothing of the owner's is written.");
registerNotSecretWrite("deleteComputer", "Removing a paired computer revokes its token and writes nothing.");

/** The characters of a pairing code: no 0, O, 1 or I, so a person reads it off a screen without a doubt. */
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** A computer's token starts with this, so a secret scanner knows one. */
export const ATTACH_TOKEN_PREFIX = "art_";
/** Pair tries a source address makes in a minute; the next waits. */
export const PAIR_TRIES_PER_MINUTE = 10;
/** Daemon fetches a minted machine's token makes in a minute (GET /v2/computers/daemon); the next is 429. */
export const DAEMON_FETCHES_PER_MINUTE = 10;
const MINUTE_MS = 60_000;
/** The most keys a minute limit keeps at once; past it, those with no try in the window go first. */
const LIMIT_KEYS = 10_000;
/** The one key the keys the full table has no room for are counted under (no address's or machine's has a space). */
const OVERFLOW_KEY = "every key past the table";
/** The longest name a person gives a computer, in characters. */
export const PAIRED_NAME_MAX = 100;
/** A WebSocket close frame's reason holds at most this many bytes of UTF-8. */
const CLOSE_REASON_BYTES = 123;

/** What the store keeps of a secret: its SHA-256, in hex. */
export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** A new pairing code: eight characters of PAIRING_ALPHABET in two groups of four ("K7PD-W3QX"). */
export function newPairingCode(pick: (below: number) => number = randomInt): string {
  const chars = Array.from({ length: 8 }, () => PAIRING_ALPHABET[pick(PAIRING_ALPHABET.length)]!);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** A code as a person typed it, in its one form ("k7pd w3qx" is "K7PD-W3QX"), or undefined when it is not one. */
export function pairingCodeOf(typed: unknown): string | undefined {
  if (typeof typed !== "string") return undefined;
  const bare = typed.toUpperCase().replace(/[\s-]+/g, "");
  const code = `${bare.slice(0, 4)}-${bare.slice(4)}`;
  return bare.length === 8 && PAIRING_CODE_PATTERN.test(code) ? code : undefined;
}

/** A new paired computer's id: PAIRED_ID_PREFIX and 16 lowercase letters and digits. */
export const newPairedId = (pick: (below: number) => number = randomInt): string =>
  `${PAIRED_ID_PREFIX}${Array.from({ length: 16 }, () => "abcdefghijkmnpqrstuvwxyz23456789"[pick(32)]).join("")}`;

/** A new machine token, a paired computer's or a hosted machine's (which goes in its env): ATTACH_TOKEN_PREFIX and 32
 *  random bytes in hex, the one shape computerd takes. */
export const newMachineToken = (): string => `${ATTACH_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;

/** The computerd builds a minted machine fetches (GET /v2/computers/daemon?arch=), each at hostedDaemonPath: the file a
 *  hosted provider uploads by default, so the route serves the bytes whose SHA-256 the provider puts in the machine's env. */
const DAEMON_ARCHES = ["amd64", "arm64"] as const;
const isDaemonArch = (arch: string | null): arch is (typeof DAEMON_ARCHES)[number] => (DAEMON_ARCHES as readonly (string | null)[]).includes(arch);

/** `reason` cut to what a close frame holds (123 bytes of UTF-8), never inside a character. */
export function closeReason(reason: string): string {
  if (Buffer.byteLength(reason) <= CLOSE_REASON_BYTES) return reason;
  let cut = "";
  for (const char of reason) {
    if (Buffer.byteLength(cut + char) > CLOSE_REASON_BYTES - 3) break;
    cut += char;
  }
  return `${cut}...`;
}

/** A limit of `perMinute` tries a minute by key: the pair route's by source address (`keyOf` peerKey: an IPv6 one by its
 *  /64), the daemon route's by the minted token's machine. */
export class MinuteLimit {
  readonly #tries = new Map<string, number[]>();
  constructor(
    private readonly perMinute: number,
    private readonly keyOf: (key: string) => string = (key) => key,
    private readonly now: () => number = Date.now,
    private readonly keys = LIMIT_KEYS,
  ) {}

  /** Counts a try by `key`: ok, or how long until the next is let in. */
  allow(given: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    let key = this.keyOf(given);
    if (!this.#tries.has(key) && this.#tries.size >= this.keys) {
      for (const [known, at] of this.#tries) if (!at.some((one) => now - one < MINUTE_MS)) this.#tries.delete(known);
      // A table still full of keys trying now counts every key it has no room for as one: the table never grows past its
      // bound, and no key goes uncounted.
      if (this.#tries.size >= this.keys) key = OVERFLOW_KEY;
    }
    const recent = (this.#tries.get(key) ?? []).filter((at) => now - at < MINUTE_MS);
    if (recent.length >= this.perMinute) return { ok: false, retryAfterMs: recent[0]! + MINUTE_MS - now };
    this.#tries.set(key, [...recent, now]);
    return { ok: true };
  }
}

/** The pair route's limit: PAIR_TRIES_PER_MINUTE tries a minute by source address. */
export const pairTries = (now: () => number = Date.now, keys = LIMIT_KEYS): MinuteLimit => new MinuteLimit(PAIR_TRIES_PER_MINUTE, peerKey, now, keys);

/** A 429 for a limit's refusal, saying how long to wait. */
const limited = (what: string, retryAfterMs: number): ApiError => {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new ApiError("rate_limited", `${what}; try again in ${seconds} s`, { retry_after_ms: retryAfterMs }, { "retry-after": String(seconds) });
};

const KINDS: ReadonlySet<string> = new Set(["linux", "desktop", "android", "ios", "browser"]);
const OSES: ReadonlySet<string> = new Set(["linux", "windows", "macos", "android", "ios"]);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** POST /v2/computers/pair's body checked: its code in its one form, the name, and the driver's hello; or input_invalid
 *  naming each field that is wrong. The protocol version is the caller's next check (pairRefusal), not this one's. */
export function pairBodyOf(body: unknown): { code: string; name: string; hello: HelloResult } {
  const issues: InputIssue[] = [];
  const said = isObject(body) ? body : {};
  if (!isObject(body)) issues.push({ field: "body", reason: "wrong_type", message: "the body is {code, name, hello}: the pairing code the console showed, the computer's name, and its driver's hello" });
  const code = pairingCodeOf(said.code);
  if (isObject(body) && code === undefined) issues.push({ field: "code", reason: "invalid", message: "code is the pairing code the console showed: eight letters and digits, such as K7PD-W3QX" });
  const name = typeof said.name === "string" ? said.name.trim() : "";
  if (isObject(body) && (name === "" || Array.from(name).length > PAIRED_NAME_MAX || /\p{Cc}/u.test(name))) {
    issues.push({ field: "name", reason: "invalid", message: `name is what you call the computer, 1 to ${PAIRED_NAME_MAX} characters on one line` });
  }
  const hello = said.hello;
  if (isObject(body)) {
    if (!isObject(hello)) issues.push({ field: "hello", reason: "wrong_type", message: "hello is the driver's own answer to hello: {protocol, version, os, kind, arch, groups}" });
    else {
      for (const field of ["protocol", "version", "arch"] as const) {
        if (typeof hello[field] !== "string" || hello[field] === "") issues.push({ field: `hello.${field}`, reason: "missing", message: `hello.${field} is a string, as the driver's hello answers it` });
      }
      if (typeof hello.os !== "string" || !OSES.has(hello.os)) issues.push({ field: "hello.os", reason: "invalid", message: `hello.os is one of ${[...OSES].join(", ")}` });
      if (typeof hello.kind !== "string" || !KINDS.has(hello.kind)) issues.push({ field: "hello.kind", reason: "invalid", message: `hello.kind is one of ${[...KINDS].join(", ")}` });
      if (!Array.isArray(hello.groups) || !hello.groups.every((group) => typeof group === "string")) issues.push({ field: "hello.groups", reason: "wrong_type", message: "hello.groups is a list of the driver's capability groups" });
    }
  }
  if (issues.length > 0) throw invalid(issues);
  return { code: code!, name, hello: hello as unknown as HelloResult };
}

/** Why a driver's hello may not pair here, in the version rule's words (attach.ts helloMismatch), or undefined: its
 *  protocol version must be this server's. The code stays good, for the driver once it is updated. */
export function pairRefusal(name: string, hello: HelloResult): string | undefined {
  if (hello.protocol === PROTOCOL_VERSION) return undefined;
  return `${name}'s driver ${hello.version} speaks protocol ${hello.protocol}, and this server ${PROTOCOL_VERSION}: update whichever is older (the driver on that computer, or this server, which whoever runs it updates), then pair with the same code`;
}

/** A paired computer as GET /v2/computers lists it under `paired`: whatever its hello says it is (its os and version, its
 *  device, its screen, its groups and features: the live hello's while it is attached, else its last one), the
 *  setting kinds it serves and why it serves none, whether it is attached now, its driver's build, and the run that holds it and until when.
 *  Nothing here is any one OS's: a driver on any OS is shown by the same fields. */
export type PairedView = {
  id: string;
  name: string;
  kind: string;
  serves: string[];
  /** When it serves no kind, why, naming what its driver lacks (servesNoKind); null when it serves one. */
  unserved: string | null;
  /** On a server whose runner runs in a process of its own, why no run here can use it and how to start the server
   *  instead (RUNNER_APART_WORDS); null where its runs can. */
  runs_refused: string | null;
  os: string;
  os_version: string | null;
  device: { maker: string; model: string } | null;
  arch: string;
  screen: { width: number; height: number; scale: number } | null;
  groups: string[];
  features: Record<string, true | { off: string }>;
  driver: string;
  online: boolean;
  held_by_run: string | null;
  held_until: string | null;
  /** The pairing (createPairing's id) whose code paired it. */
  pairing: string;
  created_at: string;
  /** Its last hello: the live socket's while it is attached (never null while online), else the last one kept. */
  seen_at: string | null;
};

/** A hello's features as the list shows them: each that is on (true) or off with why ({off: words}); anything else a
 *  driver sent is left out, so a malformed hello never reaches the console as a shape it does not know. */
function featuresOf(features: unknown): Record<string, true | { off: string }> {
  if (!isObject(features)) return {};
  return Object.fromEntries(Object.entries(features).flatMap(([name, value]): [string, true | { off: string }][] => (value === true ? [[name, true]] : isObject(value) && typeof value.off === "string" ? [[name, { off: value.off }]] : [])));
}

export function pairedView(row: PairedComputerRow, hub: Pick<AttachHub, "online" | "since" | "hello" | "claimed" | "deadline">, serves: readonly string[], runnerApart = false): PairedView {
  const paired = row.hello as Partial<HelloResult>;
  // Kind and os stay what it paired as (another is refused at hello); the rest follows its driver's live hello.
  const hello: Partial<HelloResult> = hub.hello(row.id) ?? paired;
  const holder = hub.claimed(row.id)?.[RUN_LABEL] ?? null;
  const until = holder === null ? undefined : hub.deadline(row.id);
  // The hub has the socket live before the store keeps its hello (attach's accept, then seen), so a list between the
  // two reads the hub's time: an online computer is never listed as never seen.
  const seen = hub.since(row.id)?.getTime() ?? row.seenAt;
  return {
    id: row.id,
    name: row.name,
    kind: String(paired.kind ?? ""),
    serves: [...serves],
    unserved: serves.length === 0 ? (servesNoKind(row.name, paired) ?? null) : null,
    runs_refused: runnerApart ? RUNNER_APART_WORDS : null,
    os: String(paired.os ?? ""),
    os_version: typeof hello.osVersion === "string" ? hello.osVersion : null,
    device: hello.device && typeof hello.device.maker === "string" && typeof hello.device.model === "string" ? { maker: hello.device.maker, model: hello.device.model } : null,
    arch: String(hello.arch ?? paired.arch ?? ""),
    screen: hello.screen && [hello.screen.width, hello.screen.height, hello.screen.scale].every((n) => typeof n === "number") ? { width: hello.screen.width, height: hello.screen.height, scale: hello.screen.scale } : null,
    groups: Array.isArray(hello.groups) ? hello.groups.map(String) : [],
    features: featuresOf(hello.features),
    driver: hub.hello(row.id)?.version ?? row.driver,
    online: hub.online(row.id),
    held_by_run: holder,
    held_until: until === undefined ? null : until.toISOString(),
    pairing: row.pairingId,
    created_at: new Date(row.createdAt).toISOString(),
    seen_at: seen === null ? null : new Date(seen).toISOString(),
  };
}

/** The close ws starts on a frame it refuses (its receiver's error codes): 1009 for one over maxPayload, 1007 for text
 *  that is not UTF-8; any other is 1002. */
const RECEIVER_CLOSES: Readonly<Record<string, number>> = { WS_ERR_UNSUPPORTED_MESSAGE_LENGTH: 1009, WS_ERR_INVALID_UTF8: 1007 };

/** How the socket's liveness is timed: ATTACH_HEARTBEAT_MS and ATTACH_IDLE_MS, unless a test gives its own. */
export type AttachTiming = { readonly heartbeatMs: number; readonly idleMs: number };

/** One WebSocket as the hub takes it (attach.ts AttachSocket): text frames in and out; a ping each heartbeat; closed
 *  with ATTACH_CLOSE.idle once nothing (no frame, ping or pong) is heard for idleMs, and with ATTACH_CLOSE.binary on a
 *  binary frame. A frame over MAX_LINE_BYTES is the server's maxPayload, which closes it with 1009 itself. `closing` is
 *  told each close this side starts, when it starts: a peer that does not answer it (an idle one) ends the socket only
 *  once ws gives up on it. */
export function attachSocketOf(ws: WebSocket, timing: AttachTiming = { heartbeatMs: ATTACH_HEARTBEAT_MS, idleMs: ATTACH_IDLE_MS }, closing?: (code: number, reason: string) => void): AttachSocket {
  const texts: ((text: string) => void)[] = [];
  const closes: ((code: number, reason: string) => void)[] = [];
  let ended: { code: number; reason: string } | undefined;
  let heard = Date.now();
  const hear = () => void (heard = Date.now());
  const close = (code: number, reason: string) => {
    if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) return;
    ws.close(code, closeReason(reason));
    closing?.(code, reason);
  };
  const beat = setInterval(() => {
    if (Date.now() - heard >= timing.idleMs) return close(ATTACH_CLOSE.idle, `nothing heard for ${Math.round(timing.idleMs / 1000)} s`);
    if (ws.readyState === ws.OPEN) ws.ping();
  }, Math.min(timing.heartbeatMs, timing.idleMs));
  beat.unref();
  ws.on("ping", hear);
  ws.on("pong", hear);
  ws.on("message", (data, binary) => {
    hear();
    if (binary) return close(ATTACH_CLOSE.binary, "the attach binding takes text frames only");
    // The server's binaryType is nodebuffer: a message, fragmented or not, is one Buffer.
    const text = (data as Buffer).toString("utf8");
    for (const listener of texts) listener(text);
  });
  // A socket that errs (a frame over maxPayload, a broken frame) is closed by ws, which then emits close; ws stops reading
  // it there, so a peer's answer to that close may never be read: the close it started is told at once.
  ws.on("error", (error: Error & { code?: unknown }) => {
    if (typeof error.code === "string" && error.code.startsWith("WS_ERR_")) closing?.(RECEIVER_CLOSES[error.code] ?? 1002, error.message);
  });
  ws.on("close", (code, reason) => {
    clearInterval(beat);
    ended = { code, reason: reason.toString("utf8") };
    for (const listener of closes.splice(0)) listener(ended.code, ended.reason);
  });
  return {
    send: (text) => void (ws.readyState === ws.OPEN ? ws.send(text) : undefined),
    close,
    onText: (listener) => void texts.push(listener),
    onClose: (listener) => (ended ? listener(ended.code, ended.reason) : void closes.push(listener)),
  };
}

export interface AttachRoutesOptions {
  readonly store: { readonly pairedComputers: PairedComputers; readonly mintedTokens: MintedTokens };
  readonly hub: AttachHub;
  /** Told each event worth a line: a computer paired, attached, refused at its hello, removed; a machine's token minted
   *  or revoked. Never a code or a token, nor a token's hash. */
  readonly log?: (event: string, fields: Record<string, string>) => void;
  /** An API-only server's (api-only.ts): the socket takes a hosted machine's minted token alone, and a paired computer's
   *  (the console's) is 401 as one it does not know. */
  readonly machinesOnly?: boolean;
  /** No runner in this server's process (ServeOptions.runnerApart): a pairing code and the pair answer say no run here
   *  can use a paired computer, and how to start the server so one can (RUNNER_APART_WORDS). */
  readonly runnerApart?: boolean;
  /** The socket's liveness timing: the protocol's unless a test gives its own. */
  readonly timing?: AttachTiming;
  readonly now?: () => number;
  /** Told each socket taken, with its computer, before its hello: the binding's conformance run (attach-conformance.ts)
   *  watches the raw socket to see how a driver answers a close, a drop and a frame it must refuse. */
  readonly onSocket?: (computer: string, ws: WebSocket) => void;
  /** A runner in a process of its own (dial-relay.ts): the tokens it mints name it and this incarnation, and the socket
   *  takes a machine's token only where its row names both. */
  readonly owner?: { readonly runner: string; readonly incarnation: string };
  /** The server's relay of a dial whose token another runner minted: where each runner's attach listener answers, and
   *  the hosts it may dial with the proxy's proof (live-reach.ts). Without it such a dial is refused 503. */
  readonly relay?: { readonly relays: Pick<RunnerRelays, "get">; readonly reach: LiveReach };
}

/** A request's Bearer token, or undefined. */
export const bearerOf = (authorization: string | undefined): string | undefined => /^Bearer (\S+)$/.exec(String(authorization ?? ""))?.[1];

/** How often a runner's attach listener says it is there (its runner_relays row's seen_at), and how long after its last
 *  word the server takes it as gone. */
export const RELAY_RENEW_MS = 10_000;
export const RELAY_STALE_MS = 3 * RELAY_RENEW_MS;
/** How long the server waits for a runner's attach listener to take a relayed dial. */
export const RELAY_CONNECT_MS = 10_000;

/** A close code one side of a relay may send the other: its own, or 1001 for one a peer may not send (1005, 1006). */
const sendable = (code: number): number => ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999) ? code : ATTACH_CLOSE.going);

/** Two WebSockets joined frame by frame, each an attach socket with `timing` (attachSocketOf: its idle close, its binary
 *  refusal, the server's maxPayload), each closing the other with its code and reason: once it ended, or as soon as it
 *  starts a close of its own, so an idle peer's close reaches the other side at once. */
export function joinSockets(one: WebSocket, other: WebSocket, timing?: AttachTiming): void {
  const sides: AttachSocket[] = [];
  const [a, b] = [one, other].map((ws, at) => attachSocketOf(ws, timing, (code, reason) => sides[1 - at]!.close(sendable(code), reason)));
  sides.push(a!, b!);
  a!.onText((text) => b!.send(text));
  b!.onText((text) => a!.send(text));
  a!.onClose((code, reason) => b!.close(sendable(code), reason));
  b!.onClose((code, reason) => a!.close(sendable(code), reason));
}

/** The attach socket's 401: a token no paired computer or hosted machine has good. */
const TOKEN_REFUSED = "no paired computer or hosted machine has this token: pair the computer again from the console's Computers page (a hosted machine's token ends at its delete or its backstop)";
/** The daemon route's 401: a token no hosted machine has good. */
const MACHINE_TOKEN_REFUSED = "no hosted machine has this token: a machine's token ends at its delete or its backstop";

/** A minted machine's dial, as the words about it say it: by its run where its create named one, the machine after;
 *  else by the machine. Never its token. */
const dialOf = (row: Pick<MintedTokenRow, "run" | "machine">): string => (row.run !== null ? `a dial for run ${row.run} (machine ${row.machine})` : `a dial for machine ${row.machine}`);

/** Why a minted machine's socket closed at its token's revoke. */
const machineGone = (machine: string): string => `${machine} was deleted: its token ends`;

/** The pairing routes, the attach socket and the daemon route over one store and one hub, and the tokens a dial
 *  provider mints. */
export function createAttachRoutes(options: AttachRoutesOptions) {
  const { store, hub, log = () => {}, now = Date.now } = options;
  const runsRefused = options.runnerApart === true ? RUNNER_APART_WORDS : null;
  const paired = store.pairedComputers;
  const minted = store.mintedTokens;
  const tries = pairTries(now);
  const fetches = new MinuteLimit(DAEMON_FETCHES_PER_MINUTE, undefined, now);
  const sockets = new Set<WebSocket>();
  let closing = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINE_BYTES, clientTracking: false, handleProtocols: () => ATTACH_SUBPROTOCOL });

  /** POST /v2/computers/pairings: a new code, good once until it expires. The store keeps its hash. */
  async function createPairing(): Promise<{ id: string; code: string; expires_at: string; runs_refused: string | null }> {
    const code = newPairingCode();
    const id = `pairing-${randomBytes(9).toString("base64url")}`;
    const expiresAt = now() + PAIRING_CODE_TTL_MS;
    await paired.addCode(id, sha256Hex(code), expiresAt);
    return { id, code, expires_at: new Date(expiresAt).toISOString(), runs_refused: runsRefused };
  }

  /** POST /v2/computers/pair: the code traded for the computer's id and token, once; `address` the try's source. */
  async function pair(body: unknown, address: string): Promise<{ computer: string; token: string; runs_refused: string | null }> {
    const allowed = tries.allow(address);
    if (!allowed.ok) throw limited("too many pairing tries from this address", allowed.retryAfterMs);
    const { code, name, hello } = pairBodyOf(body);
    const refused = pairRefusal(name, hello);
    if (refused) throw invalid([{ field: "hello.protocol", reason: "invalid", message: refused }]);
    // A hello that serves no kind pairs a computer no agent could pick: refused, the code kept for the updated driver.
    const unserved = servesNoKind(name, hello);
    if (unserved) throw invalid([{ field: "hello.groups", reason: "invalid", message: unserved }]);
    const id = newPairedId();
    const token = newMachineToken();
    const made = await paired.pair(sha256Hex(code), { id, name, hello: hello as unknown as Record<string, unknown>, labels: {}, tokenSha256: sha256Hex(token) });
    if (!made) throw new ApiError("not_found", "no such pairing code: make a new one on the console's Computers page");
    log("computer_paired", { computer: id, kind: hello.kind, os: hello.os, driver: hello.version });
    return { computer: id, token, runs_refused: runsRefused };
  }

  /** DELETE /v2/computers/{id}: its token revoked, a run's hold on it ended, its socket closed with 4401. */
  async function remove(id: string): Promise<void> {
    const row = await paired.get(id);
    if (row === undefined || row.revokedAt !== null || !(await paired.revoke(id))) throw new ApiError("not_found", `no paired computer ${id}: GET /v2/computers lists them under paired`);
    hub.revoke(id, `${row.name} was removed from this server's console: pair it again to use it`);
    log("computer_removed", { computer: id });
  }

  /** A dial provider's tokens (computer package MachineTokens): a new one per create, kept as its SHA-256 by the machine
   *  (its name, from its create's request id) until `expiresAt` (its backstop); a revoke (its delete) ends it and closes
   *  its socket with 4401. */
  const machineTokens: MachineTokens = {
    async mint(machine, { kind, os, arch, expiresAt, run }) {
      const until = expiresAt.getTime();
      if (!Number.isFinite(until)) throw new TypeError(`a machine token's expiresAt is a time, not ${JSON.stringify(expiresAt)}`);
      const token = newMachineToken();
      await minted.mint({ machine, tokenSha256: sha256Hex(token), kind, os, arch, expiresAt: until, ...(options.owner ?? {}), ...(run !== undefined ? { run } : {}) });
      log("machine_token_minted", { ...(run !== undefined ? { run } : {}), machine, kind, os, arch, expires_at: new Date(until).toISOString() });
      return token;
    },
    async revoke(machine) {
      await minted.revoke(machine);
      hub.revoke(machine, machineGone(machine));
      log("machine_token_revoked", { machine });
    },
    // The server's relay refusal of this machine's dial, kept on its token's row (relayDial): the minting runner's
    // create, waiting on its own hub, ends in these words at once.
    async refused(machine) {
      return (await minted.get(machine))?.refused ?? undefined;
    },
  };

  /** Who dials the attach socket, as the hub takes it: a paired computer by its id, or a minted machine by its name (its
   *  hello must say the kind, os and arch it was minted for). `good` reads its row again once the hub has the socket;
   *  `seen` keeps a paired computer's hello. Its log lines are `<event>_attached` and `<event>_refused`. */
  type Dialer = { computer: PairedComputer; field: string; event: string; gone: string; good: () => Promise<boolean>; seen: (hello: HelloResult) => Promise<void> };
  const pairedDialer = (row: PairedComputerRow): Dialer => ({
    computer: pairedOf(row),
    field: "computer",
    event: "computer",
    gone: `${row.name} was removed from this server's console: pair it again to use it`,
    good: async () => (await paired.get(row.id))?.revokedAt === null,
    seen: (hello) => paired.seen(row.id, hello as unknown as Record<string, unknown>),
  });
  const machineDialer = (row: MintedTokenRow): Dialer => ({
    computer: mintedComputer(row.machine, { kind: row.kind as ComputerKind, os: row.os as ComputerOs, arch: row.arch }),
    field: "machine",
    event: "machine",
    gone: machineGone(row.machine),
    good: async () => (await minted.get(row.machine))?.revokedAt === null,
    seen: async () => undefined,
  });

  /** The minted machine whose good token `authorization` bears (Bearer), or undefined. */
  async function machineBy(authorization: string | undefined): Promise<MintedTokenRow | undefined> {
    const bearer = bearerOf(authorization);
    return bearer?.startsWith(ATTACH_TOKEN_PREFIX) ? minted.byToken(sha256Hex(bearer)) : undefined;
  }

  /** Whether the socket here takes `row`'s machine: on a runner's listener (owner), only a token that runner minted in
   *  this incarnation; on the server, one its own process minted (another runner's is relayed, `relayDial`). */
  const takes = (row: MintedTokenRow): boolean => (options.owner ? row.runner === options.owner.runner && row.incarnation === options.owner.incarnation : row.runner === null);

  /** The server's relay of machine `row`'s dial (its token `bearer`) to the runner that minted it: refused 503 in words
   *  that name its run, then the machine (dialOf), never its token, where that runner keeps no fresh listener, restarted
   *  since, answers at a host this server does not dial, or does not take it; else the machine's socket is joined to one
   *  opened to the runner's listener with the proxy's proof for this token, runner and incarnation, each with this
   *  module's limits. */
  async function relayDial(row: MintedTokenRow, bearer: string, req: IncomingMessage, socket: Duplex, head: Buffer, deny: (status: string, words?: string) => void): Promise<void> {
    const runner = row.runner!;
    const named = { ...(row.run !== null ? { run: row.run } : {}), machine: row.machine, runner };
    const refuse = (why: string) => {
      const words = `${dialOf(row)}: ${why}`;
      log("machine_relay_refused", { ...named, why: words });
      // Kept on the token's row, where the runner's create waiting for this machine reads it (MachineTokens refused).
      void minted.refuse(sha256Hex(bearer), words).catch((error: unknown) => log("machine_relay_refusal_unkept", { ...named, error: error instanceof Error ? error.message : String(error) }));
      deny("503 Service Unavailable", words);
    };
    if (options.relay === undefined) return refuse(`runner ${runner} made it, and this server relays no dial to a runner`);
    const at = await options.relay.relays.get(runner);
    if (at === undefined || at.seenAt < now() - RELAY_STALE_MS) return refuse(`runner ${runner}, which made it, is not running now (no attach listener of its has said it is there for ${RELAY_STALE_MS / 1000} s): its run makes a new machine at its next claim`);
    if (at.incarnation !== row.incarnation) return refuse(`runner ${runner}, which made it, restarted since, and the machine was its earlier process's: its run makes a new machine at its next claim`);
    const host = dialHost(at.host, options.relay.reach);
    if (host === undefined) return refuse(`runner ${runner}, which made it, answers at ${at.host}, which is not one of this server's runners' hosts (AGENTRUN_RUNNER_HOSTS)`);
    const proof = relayProof(options.relay.reach, { tokenSha256: sha256Hex(bearer), runner, incarnation: at.incarnation });
    const upstream = new WebSocket(`ws://${host}:${at.port}${ATTACH_PATH}`, ATTACH_SUBPROTOCOL, {
      headers: { authorization: `Bearer ${bearer}`, [LIVE_PROOF_HEADER]: proof },
      maxPayload: MAX_LINE_BYTES, perMessageDeflate: false, followRedirects: false, handshakeTimeout: RELAY_CONNECT_MS,
    });
    let settled = false;
    upstream.once("unexpected-response", (_request, res) => {
      settled = true;
      res.resume();
      upstream.terminate();
      refuse(`runner ${runner}, which made it, did not take it (HTTP ${res.statusCode})`);
    });
    upstream.on("error", (error) => {
      if (settled) return;
      settled = true;
      // The library's words name the address and the step, never a header.
      refuse(`runner ${runner}, which made it, did not answer at ${host}:${at.port} (${error.message})`);
    });
    upstream.once("open", () => {
      settled = true;
      if (socket.destroyed || closing) {
        upstream.terminate();
        return void socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        for (const one of [ws, upstream]) {
          sockets.add(one);
          one.once("close", () => sockets.delete(one));
        }
        joinSockets(ws, upstream, options.timing);
        log("machine_relayed", named);
      });
    });
  }

  /** GET /v2/computers/daemon?arch=: the path of this server's computerd build for `arch`, for the minted machine whose
   *  token `authorization` bears. 401 for a token no machine has good (unknown, revoked or past its end); 429 past
   *  DAEMON_FETCHES_PER_MINUTE a minute by one machine; 422 for an arch with no build. */
  async function daemon(authorization: string | undefined, arch: string | null): Promise<string> {
    const machine = await machineBy(authorization);
    if (machine === undefined) throw new ApiError("unauthenticated", MACHINE_TOKEN_REFUSED, {}, { "www-authenticate": "Bearer" });
    const allowed = fetches.allow(machine.machine);
    if (!allowed.ok) throw limited("too many daemon fetches with this machine's token", allowed.retryAfterMs);
    if (!isDaemonArch(arch)) throw invalid([{ field: "arch", reason: "invalid", message: `arch is the machine's, ${DAEMON_ARCHES.join(" or ")}` }]);
    return hostedDaemonPath(arch);
  }

  /** GET /v2/computers/attach's upgrade: the token's paired computer or minted machine, then the protocol, then the hub's
   *  hello. A refusal is an HTTP answer before the upgrade (401 for a token neither has good, 426 for another protocol
   *  version). A minted machine's socket goes to the hub under its name. */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deny: (status: string, words?: string, headers?: Record<string, string>) => void): void {
    void (async () => {
      if (closing) return deny("503 Service Unavailable", "this server is stopping");
      const bearer = bearerOf(req.headers.authorization);
      const row = !options.machinesOnly && bearer?.startsWith(ATTACH_TOKEN_PREFIX) ? await paired.byToken(sha256Hex(bearer)) : undefined;
      const machine = row === undefined ? await machineBy(req.headers.authorization) : undefined;
      // Another runner's machine, on the server: relayed to that runner's listener below. On a runner's listener, a token
      // of any other's (another runner's, another incarnation's, the server's) is one it does not know.
      const relayed = machine !== undefined && !options.owner && machine.runner !== null;
      const dialer = row !== undefined ? pairedDialer(row) : machine !== undefined && (relayed || takes(machine)) ? machineDialer(machine) : undefined;
      if (dialer === undefined) return deny("401 Unauthorized", options.machinesOnly ? MACHINE_TOKEN_REFUSED : TOKEN_REFUSED, { "www-authenticate": "Bearer" });
      const asked = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((one) => one.trim()).filter(Boolean);
      if (!asked.includes(ATTACH_SUBPROTOCOL)) {
        return deny("426 Upgrade Required", `this server speaks ${ATTACH_SUBPROTOCOL}, and the driver asked for ${asked.join(", ") || "no subprotocol"}: update whichever is older`, { "sec-websocket-protocol": ATTACH_SUBPROTOCOL });
      }
      if (socket.destroyed || closing) return void socket.destroy();
      if (relayed) return relayDial(machine, bearer!, req, socket, head, deny);
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        ws.once("close", () => sockets.delete(ws));
        const attach = attachSocketOf(ws, options.timing);
        const { computer, field, event } = dialer;
        options.onSocket?.(computer.id, ws);
        void hub.accept(computer, attach).then(async (said) => {
          if (!said.ok) return log(`${event}_refused`, { [field]: computer.id, code: said.error.code, why: said.error.message });
          // The row read for the token may be older than a removal that committed, and its hub.revoke, while this socket
          // was still being accepted (a Postgres read and write are separate connections): read the row again, now that the
          // socket is the hub's. A removal committing after this read revokes the hub's socket after this accept, closing it.
          if (!(await dialer.good())) {
            hub.revoke(computer.id, dialer.gone);
            return log(`${event}_refused`, { [field]: computer.id, why: "removed while it attached" });
          }
          await dialer.seen(said.value);
          log(`${event}_attached`, { [field]: computer.id, driver: said.value.version });
        }).catch((error: unknown) => {
          log(`${event}_refused`, { [field]: computer.id, why: error instanceof Error ? error.message : String(error) });
          attach.close(ATTACH_CLOSE.going, "the server could not take this socket");
        });
      });
    })().catch(() => deny("500 Internal Server Error"));
  }

  /** Every attach socket closed with 1001 (the server is going), and no new one taken; resolves once each has ended. A
   *  peer that does not answer the close within a second is cut, so the server's own close never waits on it. */
  async function close(): Promise<void> {
    closing = true;
    const ended = [...sockets].map((ws) => new Promise<void>((done) => (ws.readyState === ws.CLOSED ? done() : ws.once("close", () => done()))));
    for (const ws of sockets) ws.close(ATTACH_CLOSE.going, "the server is stopping");
    const cut = setTimeout(() => { for (const ws of sockets) ws.terminate(); }, 1000);
    await Promise.all(ended);
    clearTimeout(cut);
  }

  return { createPairing, pair, remove, upgrade, close, machineTokens, daemon };
}

export type AttachRoutes = ReturnType<typeof createAttachRoutes>;
