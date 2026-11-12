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
// One process: the hub is this process's memory, so a run takes a paired computer only from a runner in the process
// that holds its socket (the CLI's start, with its runner beside the server). A runner of its own process refuses one in
// words (workspace/attached-computers.ts ONE_PROCESS_WORDS); a second server on the same store is refused at its start.
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { ATTACH_CLOSE, ATTACH_HEARTBEAT_MS, ATTACH_IDLE_MS, ATTACH_SUBPROTOCOL, type AttachHub, type AttachSocket, type HelloResult, MAX_LINE_BYTES, PAIRING_CODE_PATTERN, PAIRING_CODE_TTL_MS, PROTOCOL_VERSION, RUN_LABEL } from "@parcha/agentrun-computer";
import { type WebSocket, WebSocketServer } from "ws";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { peerKey } from "./owner.js";
import { registerNotSecretWrite } from "./secret-writes.js";
import type { PairedComputerRow, PairedComputers } from "./store/index.js";
import { pairedOf, PAIRED_ID_PREFIX } from "./workspace/attached-computers.js";

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
const PAIR_WINDOW_MS = 60_000;
/** The most source addresses the pair limit keeps at once; past it, those with no try in the window go first. */
const PAIR_PEERS = 10_000;
/** The one key the addresses the full table has no room for are counted under (no address's key has a space). */
const OVERFLOW_PEER = "every address past the table";
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

/** A new computer token: ATTACH_TOKEN_PREFIX and 32 random bytes. */
export const newAttachToken = (): string => `${ATTACH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

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

/** The pair route's limit: PAIR_TRIES_PER_MINUTE tries a minute by source address (peerKey: an IPv6 one by its /64). */
export class PairTries {
  readonly #tries = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now, private readonly peers = PAIR_PEERS) {}

  /** Counts a try from `address`: ok, or how long until the next is let in. */
  allow(address: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    let key = peerKey(address);
    if (!this.#tries.has(key) && this.#tries.size >= this.peers) {
      for (const [known, at] of this.#tries) if (!at.some((one) => now - one < PAIR_WINDOW_MS)) this.#tries.delete(known);
      // A table still full of addresses trying now counts every address it has no room for as one: the table never grows
      // past its bound, and no address goes uncounted.
      if (this.#tries.size >= this.peers) key = OVERFLOW_PEER;
    }
    const recent = (this.#tries.get(key) ?? []).filter((at) => now - at < PAIR_WINDOW_MS);
    if (recent.length >= PAIR_TRIES_PER_MINUTE) return { ok: false, retryAfterMs: recent[0]! + PAIR_WINDOW_MS - now };
    this.#tries.set(key, [...recent, now]);
    return { ok: true };
  }
}

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
 *  device, its screen, its groups and features: the live hello's while it is attached, else what it paired with), the
 *  setting kinds it serves, whether it is attached now, its driver's build, and the run that holds it and until when.
 *  Nothing here is any one OS's: a driver on any OS is shown by the same fields. */
export type PairedView = {
  id: string;
  name: string;
  kind: string;
  serves: string[];
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
  created_at: string;
  seen_at: string | null;
};

export function pairedView(row: PairedComputerRow, hub: Pick<AttachHub, "online" | "hello" | "claimed" | "deadline">, serves: readonly string[]): PairedView {
  const paired = row.hello as Partial<HelloResult>;
  // Kind and os stay what it paired as (another is refused at hello); the rest follows its driver's live hello.
  const hello: Partial<HelloResult> = hub.hello(row.id) ?? paired;
  const holder = hub.claimed(row.id)?.[RUN_LABEL] ?? null;
  const until = holder === null ? undefined : hub.deadline(row.id);
  return {
    id: row.id,
    name: row.name,
    kind: String(paired.kind ?? ""),
    serves: [...serves],
    os: String(paired.os ?? ""),
    os_version: typeof hello.osVersion === "string" ? hello.osVersion : null,
    device: hello.device && typeof hello.device.maker === "string" && typeof hello.device.model === "string" ? { maker: hello.device.maker, model: hello.device.model } : null,
    arch: String(hello.arch ?? paired.arch ?? ""),
    screen: hello.screen && typeof hello.screen.width === "number" ? { width: hello.screen.width, height: hello.screen.height, scale: hello.screen.scale } : null,
    groups: Array.isArray(hello.groups) ? hello.groups.map(String) : [],
    features: hello.features && typeof hello.features === "object" ? { ...hello.features } : {},
    driver: hub.hello(row.id)?.version ?? row.driver,
    online: hub.online(row.id),
    held_by_run: holder,
    held_until: until === undefined ? null : until.toISOString(),
    created_at: new Date(row.createdAt).toISOString(),
    seen_at: row.seenAt === null ? null : new Date(row.seenAt).toISOString(),
  };
}

/** How the socket's liveness is timed: ATTACH_HEARTBEAT_MS and ATTACH_IDLE_MS, unless a test gives its own. */
export type AttachTiming = { readonly heartbeatMs: number; readonly idleMs: number };

/** One WebSocket as the hub takes it (attach.ts AttachSocket): text frames in and out; a ping each heartbeat; closed
 *  with ATTACH_CLOSE.idle once nothing (no frame, ping or pong) is heard for idleMs, and with ATTACH_CLOSE.binary on a
 *  binary frame. A frame over MAX_LINE_BYTES is the server's maxPayload, which closes it with 1009 itself. */
export function attachSocketOf(ws: WebSocket, timing: AttachTiming = { heartbeatMs: ATTACH_HEARTBEAT_MS, idleMs: ATTACH_IDLE_MS }): AttachSocket {
  const texts: ((text: string) => void)[] = [];
  const closes: ((code: number, reason: string) => void)[] = [];
  let ended: { code: number; reason: string } | undefined;
  let heard = Date.now();
  const hear = () => void (heard = Date.now());
  const close = (code: number, reason: string) => {
    if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) return;
    ws.close(code, closeReason(reason));
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
  // A socket that errs (a frame over maxPayload, a broken frame) is closed by ws, which then emits close.
  ws.on("error", () => undefined);
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
  readonly store: { readonly pairedComputers: PairedComputers };
  readonly hub: AttachHub;
  /** Told each event worth a line: a computer paired, attached, refused at its hello, removed. Never a code or a token. */
  readonly log?: (event: string, fields: Record<string, string>) => void;
  /** The socket's liveness timing: the protocol's unless a test gives its own. */
  readonly timing?: AttachTiming;
  readonly now?: () => number;
  /** Told each socket taken, with its computer, before its hello: the binding's conformance run (attach-conformance.ts)
   *  watches the raw socket to see how a driver answers a close, a drop and a frame it must refuse. */
  readonly onSocket?: (computer: string, ws: WebSocket) => void;
}

/** The pairing routes and the attach socket over one store and one hub. */
export function createAttachRoutes(options: AttachRoutesOptions) {
  const { store, hub, log = () => {}, now = Date.now } = options;
  const paired = store.pairedComputers;
  const tries = new PairTries(now);
  const sockets = new Set<WebSocket>();
  let closing = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINE_BYTES, clientTracking: false, handleProtocols: () => ATTACH_SUBPROTOCOL });

  /** POST /v2/computers/pairings: a new code, good once until it expires. The store keeps its hash. */
  async function createPairing(): Promise<{ code: string; expires_at: string }> {
    const code = newPairingCode();
    const expiresAt = now() + PAIRING_CODE_TTL_MS;
    await paired.addCode(sha256Hex(code), expiresAt);
    return { code, expires_at: new Date(expiresAt).toISOString() };
  }

  /** POST /v2/computers/pair: the code traded for the computer's id and token, once; `address` the try's source. */
  async function pair(body: unknown, address: string): Promise<{ computer: string; token: string }> {
    const allowed = tries.allow(address);
    if (!allowed.ok) {
      const seconds = Math.max(1, Math.ceil(allowed.retryAfterMs / 1000));
      throw new ApiError("rate_limited", `too many pairing tries from this address; try again in ${seconds} s`, { retry_after_ms: allowed.retryAfterMs }, { "retry-after": String(seconds) });
    }
    const { code, name, hello } = pairBodyOf(body);
    const refused = pairRefusal(name, hello);
    if (refused) throw invalid([{ field: "hello.protocol", reason: "protocol", message: refused }]);
    const id = newPairedId();
    const token = newAttachToken();
    const made = await paired.pair(sha256Hex(code), { id, name, hello: hello as unknown as Record<string, unknown>, labels: {}, tokenSha256: sha256Hex(token) });
    if (!made) throw new ApiError("not_found", "no such pairing code: make a new one on the console's Computers page");
    log("computer_paired", { computer: id, kind: hello.kind, os: hello.os, driver: hello.version });
    return { computer: id, token };
  }

  /** DELETE /v2/computers/{id}: its token revoked, a run's hold on it ended, its socket closed with 4401. */
  async function remove(id: string): Promise<void> {
    const row = await paired.get(id);
    if (row === undefined || row.revokedAt !== null || !(await paired.revoke(id))) throw new ApiError("not_found", `no paired computer ${id}: GET /v2/computers lists them under paired`);
    hub.revoke(id, `${row.name} was removed from this server's console: pair it again to use it`);
    log("computer_removed", { computer: id });
  }

  /** GET /v2/computers/attach's upgrade: the token's computer, then the protocol, then the hub's hello. A refusal is an
   *  HTTP answer before the upgrade (401 for a token no paired computer has, 426 for another protocol version). */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deny: (status: string, words?: string, headers?: Record<string, string>) => void): void {
    void (async () => {
      if (closing) return deny("503 Service Unavailable", "this server is stopping");
      const bearer = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const row = bearer?.startsWith(ATTACH_TOKEN_PREFIX) ? await paired.byToken(sha256Hex(bearer)) : undefined;
      if (row === undefined) return deny("401 Unauthorized", "no paired computer has this token: pair the computer again from the console's Computers page", { "www-authenticate": "Bearer" });
      const asked = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((one) => one.trim()).filter(Boolean);
      if (!asked.includes(ATTACH_SUBPROTOCOL)) {
        return deny("426 Upgrade Required", `this server speaks ${ATTACH_SUBPROTOCOL}, and the driver asked for ${asked.join(", ") || "no subprotocol"}: update whichever is older`, { "sec-websocket-protocol": ATTACH_SUBPROTOCOL });
      }
      if (socket.destroyed || closing) return void socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        ws.once("close", () => sockets.delete(ws));
        const attach = attachSocketOf(ws, options.timing);
        options.onSocket?.(row.id, ws);
        void hub.accept(pairedOf(row), attach).then(async (said) => {
          if (!said.ok) return log("computer_refused", { computer: row.id, code: said.error.code, why: said.error.message });
          await paired.seen(row.id, said.value.version);
          log("computer_attached", { computer: row.id, driver: said.value.version });
        }).catch((error: unknown) => {
          log("computer_refused", { computer: row.id, why: error instanceof Error ? error.message : String(error) });
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

  return { createPairing, pair, remove, upgrade, close };
}

export type AttachRoutes = ReturnType<typeof createAttachRoutes>;
