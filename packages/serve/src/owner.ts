// The owner: the one person this server is for, signed in with a password. DIR/owner.json (0600) holds the password's
// scrypt hash with its salt and parameters, and the session epoch; DIR/.session-secret (0600) holds the key a session
// cookie is signed with. A cookie carries when it was made, when it ends (30 days) and the epoch it was made in, under an
// HMAC, and an id of its own: setting the password, signing out everywhere and `agentrun-serve reset-password` each move
// the epoch on, so every cookie made before stops working on every browser; signing out revokes the one session's id (kept
// in the owner file until that session would have ended), so a copy of that cookie stops working too, and no other. Both files are read again on every check, so a reset run beside a live
// server takes effect at once. Nothing here is ever logged but the setup code a server with a public address prints.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ipaddr from "ipaddr.js";

export const OWNER_FILE = "owner.json";
export const SESSION_SECRET_FILE = ".session-secret";
/** How long a session lasts, from the signed payload (the cookie's Max-Age only tells the browser when to drop it). */
export const SESSION_MS = 30 * 86_400_000;
const MIN_PASSWORD_CHARS = 12;
/** A longer one would only make scrypt work for nothing. */
const MAX_PASSWORD_BYTES = 1024;
/** scrypt's cost: 2^15, r 8, p 1, which OWASP gives for scrypt; kept beside each hash, so it can be raised later. */
const COST = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
/** Sign-in tries an address (peerKey) makes in a window before each next one waits, and wrong passwords the whole server
 *  takes in a window before every next try waits. */
const SIGN_INS_PER_PEER = 10;
const SIGN_IN_FREE_FAILURES = 100;
const SIGN_IN_WINDOW_MS = 15 * 60_000;
/** The wait past the free tries: 1 s after the last, doubling with each one past, never more than a minute, so the owner
 *  can always try again soon, and a guesser gets a few more tries a minute at most. */
const SIGN_IN_STEP_MS = 1_000;
export const SIGN_IN_MAX_WAIT_MS = 60_000;
/** The most addresses the sign-in limit keeps at once. A new one past it is not counted by itself (the server's own
 *  budget still holds it), and no address already counted is ever evicted to make room. */
export const SIGN_IN_PEERS = 10_000;
const SETUP_TTL_MS = 30 * 60_000;
const SETUP_TRIES = 5;

type Hash = { N: number; r: number; p: number; salt: string; hash: string };
/** `revoked`: the ids of sessions signed out one by one, each with when it would have ended; swept once past it. */
type Stored = { v: 1; epoch: number; password?: Hash; revoked?: { sid: string; exp: number }[] };

const derive = (password: string, salt: Buffer, { N, r, p }: { N: number; r: number; p: number }) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, KEY_BYTES, { N, r, p, maxmem: 256 * N * r }, (error, key) => (error ? reject(error) : resolve(key))));

/** Writes `text` to `file` whole, mode 0600: a reader sees the old file or the new one. */
function writePrivate(file: string, text: string): void {
  writeFileSync(`${file}.partial`, text, { mode: 0o600 });
  renameSync(`${file}.partial`, file);
}

/** Why `password` cannot be the owner's, or undefined. Characters are counted as a person sees them. */
export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== "string") return "password is text";
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return `password is at most ${MAX_PASSWORD_BYTES} bytes`;
  if (Array.from(password).length < MIN_PASSWORD_CHARS) return `password is ${MIN_PASSWORD_CHARS} characters or more`;
  return undefined;
}

/** The key the sign-in limit counts `address` under: an IPv4 address (an IPv4-mapped IPv6 one read as IPv4) as it is, an
 *  IPv6 one by its /64, the least one network is given, so one host can't take a fresh address for each guess. Anything
 *  else (no address) as given. */
export function peerKey(address: string): string {
  if (!ipaddr.isValid(address)) return address;
  const ip = ipaddr.process(address);
  if (ip.kind() === "ipv4") return ip.toString();
  return `${(ip as ipaddr.IPv6).parts.slice(0, 4).map((part) => part.toString(16)).join(":")}::/64`;
}

/** How long a try waits at `now`, given when the counted ones in the window were made (oldest first): nothing while fewer
 *  than `free`; past them, until SIGN_IN_STEP_MS after the last, doubled for each one past, at most SIGN_IN_MAX_WAIT_MS. */
const waitAfter = (at: readonly number[], free: number, now: number): number =>
  at.length < free ? 0 : Math.max(0, at[at.length - 1]! + Math.min(SIGN_IN_STEP_MS * 2 ** (at.length - free), SIGN_IN_MAX_WAIT_MS) - now);

/** What the sign-in limit answers a try: let in (`untracked` when the table is full and its address is counted by the
 *  server's budget only), with `done` to call once when the try ends (`wrong` for a wrong password); or how long to wait,
 *  and whether the address's tries or the server's failures hold it. */
export type SignInAllowed = { ok: true; untracked: boolean; done(wrong: boolean): void } | { ok: false; retryAfterMs: number; by: "address" | "server" };

/** The sign-in limit. Every try is counted against its address's key (peerKey) before the password is checked, so a
 *  flood never makes scrypt work past it; every wrong password is counted against the whole server, and a try let in
 *  holds a place in that count until it ends, so tries at once can't all pass before any of them fails: within the
 *  budget, no more are let in at once than its places left; past it, one at a time. Neither ever refuses for good: past
 *  its free ones each next try waits (waitAfter), and the answer says how long. */
export class SignInLimit {
  private readonly tries = new Map<string, number[]>();
  private failures: number[] = [];
  /** Tries let in and not yet ended (`done`). */
  private pending = 0;
  constructor(private readonly addresses = SIGN_IN_PEERS, private readonly now: () => number = () => Date.now()) {}

  allow(address: string): SignInAllowed {
    const now = this.now();
    const live = (at: number) => now - at < SIGN_IN_WINDOW_MS;
    this.failures = this.failures.filter(live);
    const key = peerKey(address);
    if (!this.tries.has(key) && this.tries.size >= this.addresses) for (const [known, at] of this.tries) if (!at.some(live)) this.tries.delete(known);
    const tracked = this.tries.has(key) || this.tries.size < this.addresses;
    const recent = (this.tries.get(key) ?? []).filter(live);
    const byAddress = waitAfter(recent, SIGN_INS_PER_PEER, now);
    // The server's places: its free failures left, less the tries under way; past the budget, one try at a time, each a
    // step after the one before it ends.
    const left = SIGN_IN_FREE_FAILURES - this.failures.length - this.pending;
    const byServer = left > 0 ? 0 : this.pending > 0 ? SIGN_IN_STEP_MS : waitAfter(this.failures, SIGN_IN_FREE_FAILURES, now);
    const wait = Math.max(byAddress, byServer);
    if (tracked) this.tries.set(key, wait > 0 ? recent : [...recent, now]);
    if (wait > 0) return { ok: false, retryAfterMs: wait, by: byAddress >= byServer ? "address" : "server" };
    this.pending += 1;
    let ended = false;
    const done = (wrong: boolean) => {
      if (ended) return;
      ended = true;
      this.pending -= 1;
      if (wrong) this.failures.push(this.now());
    };
    return { ok: true, untracked: !tracked, done };
  }
}

export class Owner {
  private readonly file: string;
  private readonly secret: Buffer;
  /** The sign-in limit: tries per address and wrong passwords per server (SignInLimit). */
  readonly signIns: SignInLimit;
  private setupCode: { code: string; until: number; tries: number } | null = null;
  private base = "";
  /** Taken while a first password is being set, so a second at the same moment is refused. */
  private settingUp = false;

  /** `openSetup`: no setup code; the first visit sets the password (no public address). `say` prints a setup code. */
  constructor(private readonly dir: string, readonly openSetup: boolean, private readonly say: (line: string) => void = () => {}, addresses = SIGN_IN_PEERS) {
    this.signIns = new SignInLimit(addresses);
    this.file = join(dir, OWNER_FILE);
    const secretFile = join(dir, SESSION_SECRET_FILE);
    let secret: Buffer | undefined;
    try {
      secret = Buffer.from(readFileSync(secretFile, "utf8").trim(), "base64url");
    } catch {
      // made below
    }
    if (!secret || secret.length < 32) {
      secret = randomBytes(32);
      writePrivate(secretFile, `${secret.toString("base64url")}\n`);
    }
    this.secret = secret;
    try {
      readFileSync(this.file);
    } catch {
      writePrivate(this.file, `${JSON.stringify({ v: 1, epoch: 0 } satisfies Stored)}\n`);
    }
  }

  private read(): Stored {
    const stored = JSON.parse(readFileSync(this.file, "utf8")) as Stored;
    if (stored.v !== 1 || !Number.isSafeInteger(stored.epoch)) throw new Error(`${OWNER_FILE} is not one this server reads`);
    return stored;
  }

  hasPassword(): boolean {
    return this.read().password !== undefined;
  }

  /** The address the setup link is printed with, fixed once the server listens. */
  attach(baseUrl: string): void {
    this.base = baseUrl;
  }

  /** The setup page's link: with its code when setup needs one, a new code printed (never answered) when none is good. */
  setupLink(): string {
    if (this.openSetup) return `${this.base}/setup`;
    if (!this.setupCode || Date.now() > this.setupCode.until) {
      this.setupCode = { code: randomBytes(16).toString("base64url"), until: Date.now() + SETUP_TTL_MS, tries: 0 };
      this.say(`Set up this server: ${this.base}/setup#code=${this.setupCode.code} (or paste AGENTRUN_TOKEN)`);
    }
    return `${this.base}/setup#code=${this.setupCode.code}`;
  }

  /** Whether `given` is the setup code. None given (`missing`) is no try: it never counts against the printed code. A
   *  wrong one counts, and the fifth voids it and prints a new one at once (`new`), as an expired one does. */
  private spendCode(given: unknown): "ok" | "wrong" | "missing" | "new" {
    const setup = this.setupCode;
    // None good (spent, expired, or the password was reset since): a new one goes to the log.
    if (!setup || Date.now() > setup.until) return (this.setupCode = null), this.setupLink(), "new";
    if (typeof given !== "string" || given === "") return "missing";
    const digest = (text: string) => createHash("sha256").update(text).digest();
    if (timingSafeEqual(digest(given), digest(setup.code))) return (this.setupCode = null), "ok";
    if (++setup.tries < SETUP_TRIES) return "wrong";
    this.setupCode = null;
    this.setupLink();
    return "new";
  }

  /** The first password, from setup: refused once there is one (`exists`) or while another is being set. `byToken`: the
   *  server's token stands in for the code. */
  /** `along`: what the setup keeps with the owner (setup's import), written once the setup is the one going on and before
   *  the password is: a setup that cannot write it sets no owner, and one whose password is not written takes it back. */
  async setFirst(password: string, code: unknown, byToken: boolean, along?: { keep: () => Promise<unknown>; drop: () => Promise<unknown> }): Promise<"ok" | "exists" | "wrong" | "missing" | "new"> {
    if (this.settingUp || this.hasPassword()) return "exists";
    this.settingUp = true;
    try {
      if (!byToken && !this.openSetup) {
        const spent = this.spendCode(code);
        if (spent !== "ok") return spent;
      }
      await along?.keep();
      try {
        await this.setPassword(password);
      } catch (error) {
        await along?.drop();
        throw error;
      }
      return "ok";
    } finally {
      this.settingUp = false;
    }
  }

  private async setPassword(password: string): Promise<void> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, COST);
    const stored = this.read();
    writePrivate(this.file, `${JSON.stringify({ v: 1, epoch: stored.epoch + 1, password: { ...COST, salt: salt.toString("base64url"), hash: key.toString("base64url") } } satisfies Stored)}\n`);
  }

  /** Whether `password` is the owner's. scrypt runs for a wrong one as for a right one; the compare is constant-time. */
  async check(password: string): Promise<boolean> {
    const stored = this.read().password;
    const salt = stored ? Buffer.from(stored.salt, "base64url") : randomBytes(16);
    const key = await derive(password, salt, stored ?? COST);
    const expected = stored ? Buffer.from(stored.hash, "base64url") : randomBytes(KEY_BYTES);
    return stored !== undefined && key.length === expected.length && timingSafeEqual(key, expected);
  }

  /** A session cookie's value: its payload and the payload's HMAC. */
  session(): string {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({ sid: randomBytes(16).toString("base64url"), iat: now, exp: now + SESSION_MS, epoch: this.read().epoch })).toString("base64url");
    return `${payload}.${this.mac(payload)}`;
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  /** `value`'s claims when it is a session this server signed (its MAC holds), else undefined. */
  private claims(value: string): { sid: string; exp: number; epoch: unknown } | undefined {
    const dot = value.indexOf(".");
    if (dot <= 0) return undefined;
    const payload = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.mac(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      const { sid, exp, epoch } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sid?: unknown; exp?: unknown; epoch?: unknown };
      return typeof sid === "string" && sid !== "" && typeof exp === "number" ? { sid, exp, epoch } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether `value` is a session this server made, not past its end, in the current epoch, and not signed out. */
  valid(value: string): boolean {
    const claims = this.claims(value);
    if (!claims || Date.now() >= claims.exp) return false;
    const stored = this.read();
    return claims.epoch === stored.epoch && stored.password !== undefined && !(stored.revoked ?? []).some((r) => r.sid === claims.sid);
  }

  /** Signs out the one session `value` is (this browser's), on the server: its id is kept as revoked until it would have
   *  ended, and the records past theirs are swept. Nothing for a value that is no session of this server's. */
  revoke(value: string): void {
    const claims = this.claims(value);
    if (!claims) return;
    const stored = this.read();
    const now = Date.now();
    const revoked = [...(stored.revoked ?? []).filter((r) => r.exp > now && r.sid !== claims.sid), ...(claims.exp > now ? [{ sid: claims.sid, exp: claims.exp }] : [])];
    writePrivate(this.file, `${JSON.stringify({ ...stored, revoked } satisfies Stored)}\n`);
  }

  /** Ends every session, on every browser: the epoch moves on, and the revoked list, all of it older, goes. */
  signOutEverywhere(): void {
    const { revoked: _gone, ...stored } = this.read();
    writePrivate(this.file, `${JSON.stringify({ ...stored, epoch: stored.epoch + 1 } satisfies Stored)}\n`);
  }
}

/** `agentrun-serve reset-password`: clears the password and ends every session, so the next visit sets a new one. Run
 *  where the data directory is (inside the container); never an HTTP route. */
export function resetPassword(dir: string): void {
  const file = join(dir, OWNER_FILE);
  let epoch = 0;
  try {
    epoch = (JSON.parse(readFileSync(file, "utf8")) as Stored).epoch;
  } catch {
    // no owner yet: written fresh
  }
  writePrivate(file, `${JSON.stringify({ v: 1, epoch: epoch + 1 } satisfies Stored)}\n`);
}
