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
// One process: the hub is this process's memory, so a run takes a paired computer from a runner in the process that
// holds its socket (the CLI's start, with its runner beside the server), or from a runner in a process of its own that
// relays (below). A runner of its own process with no relay refuses one in words (workspace/attached-computers.ts
// ONE_PROCESS_WORDS); a second server on the same store is refused at its start.
//
// A hosted machine a runner in a process of its own made (dial-relay.ts) dials this server the same way, and its token's
// row names that runner: the server relays its socket to the runner's attach listener (`relay`), where these same routes
// (`owner`, the runner's) take it into the runner's hub. The relay is two sockets, each with this module's limits (a frame
// over MAX_LINE_BYTES, a binary frame, ATTACH_IDLE_MS of silence), joined frame by frame: a close of either closes the
// other with its code.
//
// A paired computer goes the same way while a run holds it (workspace/paired-route.ts): its route, a server setting the
// run's claim takes, names the runner whose hub holds the box for the run. The server's upgrade reads the route: none
// keeps the socket in this hub; a live one relays it to that runner's listener, whose routes take it only while the route
// still names that runner and incarnation; a stale one (its runner gone or restarted) is 503 in words, the route dropped
// and its words kept on the row. The server's tick (every PAIRED_ROUTE_MS) compares each route with where the box's
// socket is, and closes a socket that is in the wrong place with 1001: the box's own redial lands where its route says.
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { ATTACH_CLOSE, ATTACH_HEARTBEAT_MS, ATTACH_IDLE_MS, ATTACH_PATH, ATTACH_SUBPROTOCOL, type AttachHub, type AttachSocket, type ComputerKind, type ComputerOs, type HelloResult, hostedDaemonPath, MAX_LINE_BYTES, type MachineTokens, mintedComputer, newMachineToken, type PairedComputer, PAIRING_CODE_PATTERN, PAIRING_CODE_TTL_MS, PROTOCOL_VERSION, RUN_LABEL } from "@parcha/agentrun-computer";
import { WebSocket, WebSocketServer } from "ws";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { dialHost, LIVE_PROOF_HEADER, type LiveReach, RELAY_CONNECT_MS, RELAY_TOKEN_HEADER, relayProof } from "./live-reach.js";
import { peerKey } from "./owner.js";
import { registerNotSecretWrite } from "./secret-writes.js";
import { liveRelays } from "./runner/presence.js";
import { type MintedTokenRow, type MintedTokens, type PairedComputerRow, type PairedComputers, RUNNER_STALE_MS, type Runners } from "./store/index.js";
import { pairedOf, PAIRED_ID_PREFIX, RUNNER_APART_WORDS, servesNoKind } from "./workspace/attached-computers.js";
import { allRoutes, EMPTY_ROUTE, notAttachedWords, PAIRED_BRING_MS, replaceRoute, ROUTE_COMES_BACK, type Route, type RouteSettings, routeKeyOf, routeRestartedWords, seeRoute } from "./workspace/paired-route.js";

// Where they were first defined, for the readers that import them from here.
export { liveRelays, type RelayRow } from "./runner/presence.js";
export { RELAY_CONNECT_MS } from "./live-reach.js";

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
  /** On a server whose runner runs in a process of its own and relays no computer's socket, why no run here can use it
   *  and what to do instead (RUNNER_APART_WORDS); null where its runs can. */
  runs_refused: string | null;
  os: string;
  os_version: string | null;
  device: { maker: string; model: string } | null;
  arch: string;
  screen: { width: number; height: number; scale: number } | null;
  groups: string[];
  features: Record<string, true | { off: string }>;
  driver: string;
  /** Its socket is up: in this server's hub, or relayed to the runner that holds its run. */
  online: boolean;
  held_by_run: string | null;
  held_until: string | null;
  /** The runner whose hub holds it for the run (its route, workspace/paired-route.ts); null while this server's hub does. */
  held_on: string | null;
  /** Why a run's route of it was refused or dropped, in words (its runner gone or restarted, it did not reach the runner
   *  in time), until it next attaches here; null when there is nothing to say. */
  hold_note: string | null;
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

/** `row` as GET /v2/computers lists it. `runsRefused`: why no run here can use it (RUNNER_APART_WORDS), or null. `route`:
 *  its route (workspace/paired-route.ts), which names the run that holds it and the runner whose hub does while a run's
 *  claim routed it there; `relayed`: its socket is relayed to that runner now (createAttachRoutes relayedPaired). */
export function pairedView(row: PairedComputerRow, hub: Pick<AttachHub, "online" | "since" | "hello" | "claimed" | "deadline">, serves: readonly string[], runsRefused: string | null = null, route: Route = EMPTY_ROUTE, relayed = false): PairedView {
  const paired = row.hello as Partial<HelloResult>;
  // Kind and os stay what it paired as (another is refused at hello); the rest follows its driver's live hello.
  const hello: Partial<HelloResult> = hub.hello(row.id) ?? paired;
  // A run's hold on a runner's hub is the route's; on this server's hub, the hub's own.
  const routed = route.runner !== null;
  const holder = routed ? route.run : (hub.claimed(row.id)?.[RUN_LABEL] ?? null);
  const until = routed ? (route.until === null ? undefined : new Date(route.until)) : holder === null ? undefined : hub.deadline(row.id);
  // The hub has the socket live before the store keeps its hello (attach's accept, then seen), so a list between the
  // two reads the hub's time: an online computer is never listed as never seen.
  const seen = hub.since(row.id)?.getTime() ?? row.seenAt;
  return {
    id: row.id,
    name: row.name,
    kind: String(paired.kind ?? ""),
    serves: [...serves],
    unserved: serves.length === 0 ? (servesNoKind(row.name, paired) ?? null) : null,
    runs_refused: runsRefused,
    os: String(paired.os ?? ""),
    os_version: typeof hello.osVersion === "string" ? hello.osVersion : null,
    device: hello.device && typeof hello.device.maker === "string" && typeof hello.device.model === "string" ? { maker: hello.device.maker, model: hello.device.model } : null,
    arch: String(hello.arch ?? paired.arch ?? ""),
    screen: hello.screen && [hello.screen.width, hello.screen.height, hello.screen.scale].every((n) => typeof n === "number") ? { width: hello.screen.width, height: hello.screen.height, scale: hello.screen.scale } : null,
    groups: Array.isArray(hello.groups) ? hello.groups.map(String) : [],
    features: featuresOf(hello.features),
    driver: hub.hello(row.id)?.version ?? row.driver,
    online: hub.online(row.id) || relayed,
    held_by_run: holder,
    held_until: until === undefined ? null : until.toISOString(),
    held_on: route.runner,
    hold_note: route.refused,
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
  /** `settings`: where the paired computers' routes are (workspace/paired-route.ts); absent, no paired computer is
   *  routed (every one is this hub's on the server, and none is taken on a runner's listener). */
  readonly store: { readonly pairedComputers: PairedComputers; readonly mintedTokens: MintedTokens; readonly settings?: RouteSettings };
  readonly hub: AttachHub;
  /** Told each event worth a line: a computer paired, attached, refused at its hello, removed; a machine's token minted
   *  or revoked. Never a code or a token, nor a token's hash. */
  readonly log?: (event: string, fields: Record<string, string>) => void;
  /** An API-only server's (api-only.ts): the socket takes a hosted machine's minted token alone, and a paired computer's
   *  (the console's) is 401 as one it does not know. */
  readonly machinesOnly?: boolean;
  /** No runner in this server's process (ServeOptions.runnerApart): while no runner relays (`relayed`), a pairing code
   *  and the pair answer say no run here can use a paired computer, and what to do so one can (RUNNER_APART_WORDS).
   *  Not runnerApart, the route tick stops at its read while no route row is there and no box is relayed. */
  readonly runnerApart?: boolean;
  /** Whether a runner in a process of its own relays now (server.ts relayed), read at each pairing code and pair answer;
   *  absent: none does. */
  readonly relayed?: () => Promise<boolean>;
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
  readonly relay?: { readonly runners: Pick<Runners, "live">; readonly reach: LiveReach };
  /** On the server: the runner beside it in its process (Serve.beside, runner/beside.ts), whose run's route keeps a
   *  paired box in this hub. A route that names it and its incarnation is this hub's: the upgrade takes the box here,
   *  and the tick moves it here (from a runner apart that still has it) and never away. */
  readonly beside?: { readonly runner: string; readonly incarnation: string };
}

/** A request's Bearer token, or undefined. */
export const bearerOf = (authorization: string | undefined): string | undefined => /^Bearer (\S+)$/.exec(String(authorization ?? ""))?.[1];

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
  /** Why no run here can use a paired computer, read at each answer: on a server whose runner runs apart, while no
   *  runner relays. */
  const runsRefused = async (): Promise<string | null> => (options.runnerApart !== true || (await options.relayed?.()) === true ? null : RUNNER_APART_WORDS);
  const paired = store.pairedComputers;
  const minted = store.mintedTokens;
  const settings = store.settings;
  const tries = pairTries(now);
  const fetches = new MinuteLimit(DAEMON_FETCHES_PER_MINUTE, undefined, now);
  const sockets = new Set<WebSocket>();
  let closing = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINE_BYTES, clientTracking: false, handleProtocols: () => ATTACH_SUBPROTOCOL });

  // The server's side of the paired computers' routes (no owner: this is the server, not a runner's listener).
  /** Each paired computer whose socket is in this hub, by its id: the socket the tick closes for a move. */
  const home = new Map<string, WebSocket>();
  /** Each paired computer whose socket this server relays, by its id: the box's socket and the runner it goes to. */
  const relayedPaired = new Map<string, { readonly ws: WebSocket; readonly runner: string; readonly incarnation: string }>();
  /** Each paired computer the tick closed for a move, and when: mid-redial until PAIRED_BRING_MS after, never refused
   *  as not attached meanwhile. */
  const moving = new Map<string, number>();
  /** Each paired computer whose relayed dial is opening now. */
  const dialing = new Set<string>();
  /** The paired computers (not removed) by id, with their names: read once at the first tick, then kept by this
   *  server's own pair and remove answers (only the server writes paired rows). */
  let known: Map<string, string> | undefined;
  /** The pair (its name) and remove (null) answers given while that first read is pending, by computer id: its snapshot
   *  may predate them (on Postgres a read and a write are separate connections), so they go over it before it is
   *  `known`. A read that starts after an answer's commit sees it, so an answer given while no read is pending needs no
   *  keeping, and a read that fails leaves the answers to the next one. */
  let early: Map<string, string | null> | undefined;
  /** Whether a tick is running: the interval does not wait on one, and a tick then does nothing. */
  let ticking = false;

  /** A pair (`name`) or a remove (null) answered: told to `known`, or kept for the first read while it is pending. */
  function note(id: string, name: string | null): void {
    if (known === undefined) return void early?.set(id, name);
    if (name === null) known.delete(id);
    else known.set(id, name);
  }

  /** The paired computers by id: `known`, or the first read, with the answers given meanwhile over its snapshot. */
  async function knownNow(): Promise<Map<string, string>> {
    if (known !== undefined) return known;
    early = new Map();
    try {
      const read = new Map<string, string>((await paired.list()).map((row) => [row.id, row.name]));
      for (const [id, name] of early) {
        if (name === null) read.delete(id);
        else read.set(id, name);
      }
      // In the same step as the answers' merge, so none given after it misses `known`.
      known = read;
      return read;
    } finally {
      early = undefined;
    }
  }

  /** Whether `route` is a run's of the runner beside this server, in this process (`beside`): the box's place is this
   *  hub. A route of an earlier server's runner beside it names another runner (a new name and incarnation at each
   *  start), so it is stale as any runner's that is gone. */
  const besideRoute = (route: Route): boolean => options.beside !== undefined && route.runner === options.beside.runner && route.incarnation === options.beside.incarnation;

  /** POST /v2/computers/pairings: a new code, good once until it expires. The store keeps its hash. */
  async function createPairing(): Promise<{ id: string; code: string; expires_at: string; runs_refused: string | null }> {
    const code = newPairingCode();
    const id = `pairing-${randomBytes(9).toString("base64url")}`;
    const expiresAt = now() + PAIRING_CODE_TTL_MS;
    await paired.addCode(id, sha256Hex(code), expiresAt);
    return { id, code, expires_at: new Date(expiresAt).toISOString(), runs_refused: await runsRefused() };
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
    note(id, name);
    return { computer: id, token, runs_refused: await runsRefused() };
  }

  /** DELETE /v2/computers/{id}: its token revoked, a run's hold on it ended, its socket closed with 4401 (a relayed one
   *  too, which the relay carries to the runner's hub), and its route gone. */
  async function remove(id: string): Promise<void> {
    const row = await paired.get(id);
    if (row === undefined || row.revokedAt !== null || !(await paired.revoke(id))) throw new ApiError("not_found", `no paired computer ${id}: GET /v2/computers lists them under paired`);
    const gone = `${row.name} was removed from this server's console: pair it again to use it`;
    hub.revoke(id, gone);
    relayedPaired.get(id)?.ws.close(ATTACH_CLOSE.unauthorized, closeReason(gone));
    note(id, null);
    // Not in the revoke's transaction: a route left by a crash between the two names a revoked computer, whose token
    // the upgrade refuses anyway, and the tick removes it.
    await settings?.remove(routeKeyOf(id)).catch((error: unknown) => log("computer_route_unremoved", { computer: id, error: error instanceof Error ? error.message : String(error) }));
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
   *  hello must say the kind, os and arch it was minted for). `standing` reads its row again once the hub has the socket:
   *  `revoked` (its token is gone: closed with 4401 in `gone`, pair again) or, for a paired computer on a runner's
   *  listener, `moved` (its route no longer names this runner and incarnation: closed with 1001 in `moved`, its redial
   *  routed, its pairing kept). `seen` keeps a paired computer's hello. Its log lines are `<event>_attached` and
   *  `<event>_refused`. */
  type Dialer = { computer: PairedComputer; field: string; event: string; gone: string; moved: string; standing: () => Promise<"good" | "revoked" | "moved">; seen: (hello: HelloResult) => Promise<void> };
  const pairedDialer = (row: PairedComputerRow): Dialer => ({
    computer: pairedOf(row),
    field: "computer",
    event: "computer",
    gone: `${row.name} was removed from this server's console: pair it again to use it`,
    moved: `${row.name} moved while it said hello: its route left this runner, and its redial goes where the route says`,
    // Revoked first: a removal drops the route too. On a runner's listener the route must still name this runner and
    // incarnation; one that left it (a cancelled bring, a run moved) is a move, never a revoke.
    standing: async () => ((await paired.get(row.id))?.revokedAt !== null ? "revoked" : options.owner !== undefined && !(await routedHere(row.id)) ? "moved" : "good"),
    seen: (hello) => paired.seen(row.id, hello as unknown as Record<string, unknown>),
  });

  /** Whether paired computer `id`'s route names this runner's listener (`owner`) and its incarnation. */
  async function routedHere(id: string): Promise<boolean> {
    if (options.owner === undefined || settings === undefined) return false;
    const { route } = await seeRoute(settings, id);
    return route.runner === options.owner.runner && route.incarnation === options.owner.incarnation;
  }
  const machineDialer = (row: MintedTokenRow): Dialer => ({
    computer: mintedComputer(row.machine, { kind: row.kind as ComputerKind, os: row.os as ComputerOs, arch: row.arch }),
    field: "machine",
    event: "machine",
    gone: machineGone(row.machine),
    // A minted machine has no route, so it never moves: good or revoked.
    moved: machineGone(row.machine),
    standing: async () => ((await minted.get(row.machine))?.revokedAt === null ? "good" : "revoked"),
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

  /** A dial the server relays to a runner's listener, as relayDial takes it: the runner and incarnation its row names,
   *  `token` (the header that names its token on the hop: a machine's bearer, a paired box's SHA-256 alone), the dial in
   *  words (never its token), how that runner stands to it ("made it", "holds it"), the tails of the words for a runner
   *  gone and one restarted, its log event's prefix and fields, `keep` (where its refusal is kept: `stale` when the
   *  runner is gone or restarted), and `joined`, told the box's socket once the relay is up. */
  type RelayTarget = {
    readonly runner: string;
    readonly incarnation: string | null;
    readonly token: Record<string, string>;
    readonly subject: string;
    readonly whose: string;
    readonly gone: string;
    readonly restarted: string;
    readonly event: "machine" | "computer";
    readonly named: Record<string, string>;
    readonly keep: (words: string, stale: boolean) => Promise<unknown>;
    readonly joined?: (ws: WebSocket) => void;
  };

  /** A minted machine's dial to the runner that minted it, as relayDial takes it. */
  const machineTarget = (row: MintedTokenRow, bearer: string): RelayTarget => {
    const runner = row.runner!;
    return {
      runner, incarnation: row.incarnation, token: { authorization: `Bearer ${bearer}` }, subject: dialOf(row), whose: "made it",
      gone: "its run makes a new machine at its next claim",
      restarted: `runner ${runner}, which made it, restarted since, and the machine was its earlier process's: its run makes a new machine at its next claim`,
      event: "machine", named: { ...(row.run !== null ? { run: row.run } : {}), machine: row.machine, runner },
      // Kept on the token's row, where the runner's create waiting for this machine reads it (MachineTokens refused).
      keep: (words) => minted.refuse(sha256Hex(bearer), words),
    };
  };

  /** A paired computer's dial to the runner its route names (`seen`: the route's row as read), as relayDial takes it. A
   *  stale route's refusal drops the route and keeps its words on the row, in one compare-and-set on the row as read: the
   *  box's next dial lands in this hub. Any other refusal is noted on the route, so the claim waiting for the box ends at
   *  once in its words. */
  const pairedTarget = (row: PairedComputerRow, route: Route, seen: unknown, bearer: string): RelayTarget => {
    const runner = route.runner!;
    return {
      runner, incarnation: route.incarnation, token: { [RELAY_TOKEN_HEADER]: sha256Hex(bearer) }, subject: `${row.name} (${row.id}) for run ${route.run}`, whose: "holds it",
      gone: ROUTE_COMES_BACK,
      restarted: routeRestartedWords(runner),
      event: "computer", named: { run: route.run!, computer: row.id, runner },
      // Read again and tried again while the row still holds this route (the tick may have noted it meanwhile).
      keep: async (words, stale) => {
        let was = seen;
        let current = route;
        for (let tried = 0; tried < 5; tried++) {
          if (await replaceRoute(settings!, row.id, was, stale ? { ...EMPTY_ROUTE, refused: words } : { ...current, refused: words })) return true;
          const again = await seeRoute(settings!, row.id);
          if (again.route.runner !== route.runner || again.route.incarnation !== route.incarnation || again.route.run !== route.run) return false;
          ({ seen: was, route: current } = again);
        }
        return false;
      },
      joined: (ws) => {
        dialing.delete(row.id);
        relayedPaired.set(row.id, { ws, runner, incarnation: route.incarnation! });
        ws.once("close", () => {
          if (relayedPaired.get(row.id)?.ws === ws) relayedPaired.delete(row.id);
        });
        // A note an earlier dial left on the route (not attached now) goes, now that the box is there.
        if (route.refused !== null) void replaceRoute(settings!, row.id, seen, { ...route, refused: null }).catch(() => undefined);
      },
    };
  };

  /** The server's relay of a dial (its token `bearer`) to the runner its row names (`target`): refused 503 in words that
   *  name the dial (its run, then the machine or the computer), never its token, where that runner keeps no fresh
   *  listener, restarted since, answers at a host this server does not dial, or does not take it; else the box's socket
   *  is joined to one opened to the runner's listener with the proxy's proof for this token, runner and incarnation, each
   *  with this module's limits. The token goes on that hop as `target.token` names it: a paired box's never as itself. */
  async function relayDial(target: RelayTarget, bearer: string, req: IncomingMessage, socket: Duplex, head: Buffer, deny: (status: string, words?: string) => void): Promise<void> {
    const { runner, named, event } = target;
    // Kept before the answer, so whoever reads the row after the 503 (the waiting create, the box's next dial) reads it.
    // The box is told `told` where the words name where the runner answers (an internal host and port, a socket's
    // error): those stay in the log line and on the row.
    const refuse = async (why: string, stale = false, told = why): Promise<void> => {
      const words = `${target.subject}: ${why}`;
      log(`${event}_relay_refused`, { ...named, why: words });
      await target.keep(words, stale).catch((error: unknown) => log(`${event}_relay_refusal_unkept`, { ...named, error: error instanceof Error ? error.message : String(error) }));
      deny("503 Service Unavailable", `${target.subject}: ${told}`);
    };
    if (options.relay === undefined) return refuse(`runner ${runner} ${target.whose}, and this server relays no dial to a runner`);
    const at = (await liveRelays(options.relay.runners)).find((row) => row.runner === runner);
    if (at === undefined) return refuse(`runner ${runner}, which ${target.whose}, is not running now (no attach listener of its has said it is there for ${RUNNER_STALE_MS / 1000} s): ${target.gone}`, true);
    if (at.incarnation !== target.incarnation) return refuse(target.restarted, true);
    const host = dialHost(at.host, options.relay.reach);
    if (host === undefined) return refuse(`runner ${runner}, which ${target.whose}, answers at ${at.host}, which is not one of this server's runners' hosts (AGENTRUN_RUNNER_HOSTS)`, false, `runner ${runner}, which ${target.whose}, answers at a host this server does not dial (AGENTRUN_RUNNER_HOSTS)`);
    const proof = relayProof(options.relay.reach, { tokenSha256: sha256Hex(bearer), runner, incarnation: at.incarnation });
    const upstream = new WebSocket(`ws://${host}:${at.port}${ATTACH_PATH}`, ATTACH_SUBPROTOCOL, {
      headers: { ...target.token, [LIVE_PROOF_HEADER]: proof },
      maxPayload: MAX_LINE_BYTES, perMessageDeflate: false, followRedirects: false, handshakeTimeout: RELAY_CONNECT_MS,
    });
    let settled = false;
    upstream.once("unexpected-response", (_request, res) => {
      settled = true;
      res.resume();
      upstream.terminate();
      void refuse(`runner ${runner}, which ${target.whose}, did not take it (HTTP ${res.statusCode})`);
    });
    upstream.on("error", (error) => {
      if (settled) return;
      settled = true;
      // The library's words name the address and the step, never a header.
      void refuse(`runner ${runner}, which ${target.whose}, did not answer at ${host}:${at.port} (${error.message})`, false, `runner ${runner}, which ${target.whose}, did not answer`);
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
        target.joined?.(ws);
        log(`${event}_relayed`, named);
      });
    });
  }

  /** A paired computer's dial on the server, its route read (`seen`, `route`): relayed to the runner the route names,
   *  marked as dialing (the tick refuses no box mid-dial) until the relay is up or refused. */
  async function relayPaired(row: PairedComputerRow, route: Route, seen: unknown, bearer: string, req: IncomingMessage, socket: Duplex, head: Buffer, deny: (status: string, words?: string) => void): Promise<void> {
    dialing.add(row.id);
    const done = () => void dialing.delete(row.id);
    socket.once("close", done);
    try {
      await relayDial(pairedTarget(row, route, seen, bearer), bearer, req, socket, head, (status, words) => (done(), deny(status, words)));
    } catch (error) {
      done();
      throw error;
    }
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
   *  version). A minted machine's socket goes to the hub under its name.
   *
   *  On a runner's listener (`owner`), a paired computer's token comes as `hop`, its SHA-256 alone as the server's
   *  relay hop names it (dial-relay.ts reads it off RELAY_TOKEN_HEADER, its proof checked): a paired token as a bearer
   *  is one it does not know, and a hash finds no minted machine (whose token comes as its bearer). */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deny: (status: string, words?: string, headers?: Record<string, string>) => void, hop?: { readonly tokenSha256: string }): void {
    void (async () => {
      if (closing) return deny("503 Service Unavailable", "this server is stopping");
      const bearer = bearerOf(req.headers.authorization);
      const pairedSha256 = options.owner ? hop?.tokenSha256 : bearer?.startsWith(ATTACH_TOKEN_PREFIX) ? sha256Hex(bearer) : undefined;
      const found = !options.machinesOnly && pairedSha256 !== undefined ? await paired.byToken(pairedSha256) : undefined;
      // On a runner's listener, a paired computer's token is taken only while its route names this runner and incarnation:
      // any other is one it does not know.
      const row = found !== undefined && options.owner !== undefined && !(await routedHere(found.id)) ? undefined : found;
      const machine = found === undefined && hop === undefined ? await machineBy(req.headers.authorization) : undefined;
      // Another runner's machine, on the server: relayed to that runner's listener below. On a runner's listener, a token
      // of any other's (another runner's, another incarnation's, the server's) is one it does not know.
      const relayed = machine !== undefined && !options.owner && machine.runner !== null;
      const dialer = row !== undefined ? pairedDialer(row) : machine !== undefined && (relayed || takes(machine)) ? machineDialer(machine) : undefined;
      if (dialer === undefined) return deny("401 Unauthorized", options.machinesOnly ? MACHINE_TOKEN_REFUSED : TOKEN_REFUSED, { "www-authenticate": "Bearer" });
      const asked = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((one) => one.trim()).filter(Boolean);
      if (!asked.includes(ATTACH_SUBPROTOCOL)) {
        return deny("426 Upgrade Required", `this server speaks ${ATTACH_SUBPROTOCOL}, and the driver asked for ${asked.join(", ") || "no subprotocol"}: update whichever is older`, { "sec-websocket-protocol": ATTACH_SUBPROTOCOL });
      }
      // A paired computer on the server: its route says where its socket goes (no route, or a run's of the runner beside
      // this server: this hub).
      const routed = row !== undefined && !options.owner && settings !== undefined ? await seeRoute(settings, row.id) : undefined;
      if (socket.destroyed || closing) return void socket.destroy();
      if (relayed) return relayDial(machineTarget(machine, bearer!), bearer!, req, socket, head, deny);
      if (row !== undefined && routed !== undefined && routed.route.runner !== null && !besideRoute(routed.route)) return relayPaired(row, routed.route, routed.seen, bearer!, req, socket, head, deny);
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        ws.once("close", () => sockets.delete(ws));
        const attach = attachSocketOf(ws, options.timing);
        const { computer, field, event } = dialer;
        options.onSocket?.(computer.id, ws);
        if (routed !== undefined) {
          home.set(computer.id, ws);
          ws.once("close", () => {
            if (home.get(computer.id) === ws) home.delete(computer.id);
          });
        }
        void hub.accept(computer, attach).then(async (said) => {
          if (!said.ok) return log(`${event}_refused`, { [field]: computer.id, code: said.error.code, why: said.error.message });
          // The row read for the token may be older than a removal that committed, and its hub.revoke, while this socket
          // was still being accepted (a Postgres read and write are separate connections): read the row again, now that the
          // socket is the hub's. A removal committing after this read revokes the hub's socket after this accept, closing it.
          // A route that left this runner meanwhile (only a runner's listener reads one here) is a move, as the server's
          // tick closes one: this socket alone closes with 1001 and its driver redials; the pairing is untouched.
          const standing = await dialer.standing();
          if (standing === "revoked") {
            hub.revoke(computer.id, dialer.gone);
            return log(`${event}_refused`, { [field]: computer.id, why: "removed while it attached" });
          }
          if (standing === "moved") {
            ws.close(ATTACH_CLOSE.going, closeReason(dialer.moved));
            return log(`${event}_refused`, { [field]: computer.id, why: "its route left this runner while it attached" });
          }
          await dialer.seen(said.value);
          // The note a refused or dropped route left (routed.route.refused) goes, now that the box is here; a route of the
          // runner beside this server stays, its note alone gone.
          if (routed !== undefined && routed.route.refused !== null) await replaceRoute(settings!, computer.id, routed.seen, { ...routed.route, refused: null }).catch(() => undefined);
          log(`${event}_attached`, { [field]: computer.id, driver: said.value.version });
        }).catch((error: unknown) => {
          log(`${event}_refused`, { [field]: computer.id, why: error instanceof Error ? error.message : String(error) });
          attach.close(ATTACH_CLOSE.going, "the server could not take this socket");
        });
      });
    })().catch(() => deny("500 Internal Server Error"));
  }

  /** The runner paired computer `id`'s socket is relayed to now, or undefined (in this hub, or attached nowhere). */
  const relayedTo = (id: string): string | undefined => relayedPaired.get(id)?.runner;

  /** Closes a paired computer's socket with 1001 for a move, saying why, and notes it as moving: its driver redials, and
   *  the upgrade sends it where its route says. */
  const move = (id: string, ws: WebSocket, why: string): void => {
    moving.set(id, now());
    ws.close(ATTACH_CLOSE.going, closeReason(why));
  };

  /** The server's route tick (every PAIRED_ROUTE_MS, server.ts, its runner apart or beside it): one read of every route
   *  row, compared with where each box's socket is now (this hub, or the runner it is relayed to, in this process's
   *  memory). A route of the runner beside this server (besideRoute) says this hub. A socket in the wrong place (here
   *  with a runner apart's route, relayed to a runner its route no longer names, relayed with no route or with the
   *  runner beside's) is closed with 1001, its redial routed; a box routed and attached nowhere, neither moving nor
   *  mid-dial, gets its route noted "not attached now", which ends its claim's wait at once. An empty row, and a row of a
   *  computer that is no longer paired, goes. Nothing while no computer is paired; with this server's runner beside it
   *  (not runnerApart), nothing past that one read while no route row is there and no box is relayed. It judges no
   *  runner's liveness: a stale route is dropped at the box's next upgrade. One tick runs at a time: one called while
   *  another runs does nothing. */
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await judgeRoutes();
    } finally {
      ticking = false;
    }
  }

  /** One tick's work (tick). */
  async function judgeRoutes(): Promise<void> {
    if (options.owner !== undefined || settings === undefined || closing) return;
    const known = await knownNow();
    if (known.size === 0 && relayedPaired.size === 0) return;
    const rows = await allRoutes(settings);
    // With its runner beside it, only a runner apart on another host takes a route: the read says whether one did. A
    // box still relayed counts too, since the drop that ended its route (with no note) removed the row.
    if (options.runnerApart !== true && rows.length === 0 && relayedPaired.size === 0) return;
    const at = now();
    for (const [id, since] of moving) if (at - since > PAIRED_BRING_MS) moving.delete(id);
    const routes = new Map(rows.map((row) => [row.id, row.route]));
    for (const [id, relayed] of relayedPaired) {
      const route = routes.get(id);
      if (route === undefined || route.runner === null) move(id, relayed.ws, `${known.get(id) ?? id} came back to this server: no run holds it now`);
      else if (besideRoute(route)) move(id, relayed.ws, `${known.get(id) ?? id} came back to this server: run ${route.run} holds it here`);
      else if (route.runner !== relayed.runner || route.incarnation !== relayed.incarnation) move(id, relayed.ws, `${known.get(id) ?? id} moved to the runner that holds run ${route.run}`);
    }
    for (const { id, seen, route } of rows) {
      const name = known.get(id);
      if (name === undefined || (route.runner === null && route.refused === null)) {
        await replaceRoute(settings, id, seen, EMPTY_ROUTE).catch(() => undefined);
        continue;
      }
      if (route.runner === null) continue;
      const here = home.get(id);
      // A box in this hub under a run of the runner beside this server is where its route says: it stays.
      if (here !== undefined && besideRoute(route)) continue;
      if (here !== undefined) move(id, here, `${name} moved to the runner that holds run ${route.run}`);
      else if (!relayedPaired.has(id) && !moving.has(id) && !dialing.has(id) && route.refused === null) {
        await replaceRoute(settings, id, seen, { ...route, refused: notAttachedWords(name) }).catch(() => undefined);
      }
    }
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

  return { createPairing, pair, remove, upgrade, close, machineTokens, daemon, tick, relayedTo, runsRefused };
}

export type AttachRoutes = ReturnType<typeof createAttachRoutes>;
