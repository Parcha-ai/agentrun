// The owner: the one person this server is for, signed in with a password. DIR/owner.json (0600) holds the password's
// scrypt hash with its salt and parameters, and the session epoch; DIR/.session-secret (0600) holds the key a session
// cookie is signed with. A cookie carries when it was made, when it ends (30 days) and the epoch it was made in, under an
// HMAC: setting the password, signing out and `agentrun-serve reset-password` each move the epoch on, so every cookie
// made before stops working on every browser. Both files are read again on every check, so a reset run beside a live
// server takes effect at once. Nothing here is ever logged but the setup code a server with a public address prints.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
const SIGN_INS_PER_PEER = 10;
const SIGN_IN_WINDOW_MS = 15 * 60_000;
const SETUP_TTL_MS = 30 * 60_000;
const SETUP_TRIES = 5;

type Hash = { N: number; r: number; p: number; salt: string; hash: string };
type Stored = { v: 1; epoch: number; password?: Hash };

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

export class Owner {
  private readonly file: string;
  private readonly secret: Buffer;
  private readonly tries = new Map<string, number[]>();
  private setupCode: { code: string; until: number; tries: number } | null = null;
  private base = "";
  /** Taken while a first password is being set, so a second at the same moment is refused. */
  private settingUp = false;

  /** `openSetup`: no setup code; the first visit sets the password (no public address). `say` prints a setup code. */
  constructor(private readonly dir: string, readonly openSetup: boolean, private readonly say: (line: string) => void = () => {}) {
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
      this.say(`Set up this server: ${this.base}/setup#code=${this.setupCode.code}`);
    }
    return `${this.base}/setup#code=${this.setupCode.code}`;
  }

  /** Whether `given` is the setup code: wrong ones count, and the fifth voids it until a new one is printed. */
  private spendCode(given: unknown): "ok" | "wrong" | "none" {
    const setup = this.setupCode;
    // None good (spent, voided, expired, or the password was reset since): a new one goes to the log.
    if (!setup || Date.now() > setup.until) return (this.setupCode = null), this.setupLink(), "none";
    if (typeof given === "string" && given.length === setup.code.length && timingSafeEqual(Buffer.from(given), Buffer.from(setup.code))) return (this.setupCode = null), "ok";
    if (++setup.tries >= SETUP_TRIES) this.setupCode = null;
    return "wrong";
  }

  /** The first password, from setup: refused once there is one (`exists`) or while another is being set. `byToken`: the
   *  server's token stands in for the code. */
  async setFirst(password: string, code: unknown, byToken: boolean): Promise<"ok" | "exists" | "code"> {
    if (this.settingUp || this.hasPassword()) return "exists";
    this.settingUp = true;
    try {
      if (!byToken && !this.openSetup) {
        const spent = this.spendCode(code);
        if (spent !== "ok") return "code";
      }
      await this.setPassword(password);
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

  /** Whether `peer` may try a password now; counts the try. */
  allow(peer: string): boolean {
    const now = Date.now();
    const recent = (this.tries.get(peer) ?? []).filter((at) => now - at < SIGN_IN_WINDOW_MS);
    if (recent.length >= SIGN_INS_PER_PEER) return (this.tries.set(peer, recent), false);
    this.tries.set(peer, [...recent, now]);
    return true;
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
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + SESSION_MS, epoch: this.read().epoch })).toString("base64url");
    return `${payload}.${this.mac(payload)}`;
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  /** Whether `value` is a session this server made, not past its end, in the current epoch. */
  valid(value: string): boolean {
    const dot = value.indexOf(".");
    if (dot <= 0) return false;
    const payload = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.mac(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    try {
      const { exp, epoch } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown; epoch?: unknown };
      return typeof exp === "number" && Date.now() < exp && epoch === this.read().epoch && this.hasPassword();
    } catch {
      return false;
    }
  }

  /** Ends every session, on every browser. */
  signOutEverywhere(): void {
    const stored = this.read();
    writePrivate(this.file, `${JSON.stringify({ ...stored, epoch: stored.epoch + 1 })}\n`);
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
