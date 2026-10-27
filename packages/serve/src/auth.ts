// Accounts, behind AGENTRUN_ACCOUNTS=1: people with a role and no password, kept by Better Auth on node:sqlite in
// DIR/auth.sqlite. Serve keeps what the library does not: the setup code, the allowlist of its endpoints, the one write
// gate (this server's Origin and a JSON body), the 30-day limit on a session, and the activity log. A session is made
// only by the library's magic-link sign-in, run server-side: its token goes from the plugin's callback to the verify
// call in memory, and none of its endpoints is a client's.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins/admin";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { magicLink } from "better-auth/plugins/magic-link";
import { ApiError, invalid, type InputIssue } from "./errors.js";

export const AUTH_FILE = "auth.sqlite";
export const SECRET_FILE = ".auth-secret";
/** The one header the library takes the client's address from: the socket's peer, written over any value a client sent. */
export const CLIENT_IP_HEADER = "x-agentrun-client-ip";
const BASE_PATH = "/v2/auth";
const DAY_S = 86_400;
const MAX_SESSION_MS = 30 * DAY_S * 1000;
const SETUP_TTL_MS = 30 * 60_000;
const SETUP_TRIES = 5;
/** How long a sign-in token lives between the plugin's callback and its verify call, which follows at once. */
const LINK_TTL_S = 60;
const MAX_BODY = 1 << 16;

/** The library's endpoints a client may call, each with its one method. Every other path under /v2/auth is a 404: no
 *  password endpoint, no magic-link one, no sign-up (the owner is made by serve). None that takes or lists a session's
 *  token: it lives in the HttpOnly cookie only. */
const ENDPOINTS: Record<string, string> = {
  "/sign-out": "POST",
  "/get-session": "GET",
  "/revoke-other-sessions": "POST",
  "/update-user": "POST",
};

export type Role = "member" | "admin";
/** Who a request is, from its credential only: the server's token, or a signed-in person. */
export type Principal = { kind: "token"; role: "admin" } | { kind: "person"; id: string; role: Role };
export const TOKEN_PRINCIPAL: Principal = { kind: "token", role: "admin" };

export type AccountsOptions = {
  data: string;
  /** The server's token: as a Bearer it may finish setup in place of the code. */
  token: string;
  /** In place of DIR/.auth-secret: 32 characters or more. */
  secret?: string;
  /** Made the owner at start when there is none. */
  owner?: { email: string };
};

export type NewPerson = { email: string; name: string; role: Role };
/** Takes the token of a sign-in serve asked for itself, by the nonce it passed as the link's metadata. */
type Deliver = (nonce: unknown, token: string) => void;
type Person = { id: string; name: string; email: string; role: string | null; owner: number; banned: number | null; createdAt: string | number };

const digest = (text: string) => createHash("sha256").update(text).digest();
const same = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));
const isJson = (req: IncomingMessage) => String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
const roleOf = (role: string | null | undefined): Role => (role === "admin" ? "admin" : "member");
const iso = (value: string | number | Date) => new Date(value).toISOString();

/** The socket's peer, with an IPv4-mapped IPv6 address as its IPv4 one. */
export function peerOf(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "";
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(peer) ? peer.slice(7) : peer;
}

async function secretIn(file: string): Promise<string> {
  const known = await readFile(file, "utf8").then((text) => text.trim(), () => "");
  if (known.length >= 32 && !/\s/.test(known)) {
    await chmod(file, 0o600);
    return known;
  }
  const secret = randomBytes(32).toString("base64url");
  await writeFile(file, `${secret}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return secret;
}

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === "host") continue;
    for (const each of Array.isArray(value) ? value : [value]) headers.append(name, each);
  }
  return headers;
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= MAX_BODY) chunks.push(chunk as Buffer);
  }
  if (size > MAX_BODY) throw new ApiError("payload_too_large", `the body is over ${MAX_BODY} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new ApiError("bad_request", "the body is not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ApiError("bad_request", "the body is not a JSON object");
  return value as Record<string, unknown>;
}

/** The session cookie's name: `__Host-` on https, so no other host or path can set it; else one per port. */
const sessionCookie = (baseUrl: string, port: number) => (baseUrl.startsWith("https://") ? "__Host-agentrun-session" : `agentrun-${port}-session`);

/** The sign-in headers the library records on a session: the browser's user agent and the client's address. */
function signInHeaders(req?: IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of ["user-agent", CLIENT_IP_HEADER]) {
    const value = req?.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

function optionsOf(db: DatabaseSync, secret: string, site?: { baseUrl: string; port: number; origins: string[] }, deliver?: Deliver) {
  const https = site?.baseUrl.startsWith("https://") ?? false;
  const name = sessionCookie(site?.baseUrl ?? "", site?.port ?? 0);
  return {
    appName: "AgentRun Server",
    database: db,
    secret,
    // Without a site this instance only migrates and makes the owner from the environment: it builds no link.
    baseURL: site?.baseUrl ?? "http://serve",
    basePath: BASE_PATH,
    trustedOrigins: site?.origins ?? [],
    // No passwords: nobody signs in with one, and no credential is stored.
    emailAndPassword: { enabled: false },
    // 7 days idle: a session used a day or more after its last refresh runs 7 days from then.
    session: { expiresIn: 7 * DAY_S, updateAge: DAY_S },
    user: { additionalFields: { owner: { type: "boolean" as const, defaultValue: false, required: false, input: false } } },
    rateLimit: { enabled: true, storage: "database" as const },
    advanced: {
      useSecureCookies: false,
      cookiePrefix: https ? "agentrun" : `agentrun-${site?.port ?? 0}`,
      cookies: { session_token: { name } },
      defaultCookieAttributes: { httpOnly: true, sameSite: "strict" as const, secure: https, path: "/" },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    plugins: [
      admin({ defaultRole: "member", adminRoles: ["admin"], roles: { admin: adminAc, member: userAc } }),
      // Only a person who exists signs in; the token is stored hashed and consumed by its one verify. The link is never
      // sent, logged or answered: the token goes to `deliver`, in memory, or nowhere.
      magicLink({ disableSignUp: true, storeToken: "hashed", expiresIn: LINK_TTL_S, sendMagicLink: ({ token, metadata }) => deliver?.(metadata?.nonce, token) }),
    ],
    telemetry: { enabled: false },
    logger: { level: "error" as const, log: (_level: string, message: string) => void process.stderr.write(`agentrun-serve: accounts: ${message}\n`) },
  };
}
const build = (db: DatabaseSync, secret: string, site?: { baseUrl: string; port: number; origins: string[] }, deliver?: Deliver) => betterAuth(optionsOf(db, secret, site, deliver));
type Auth = ReturnType<typeof build>;

/** The accounts database, migrated, with its secret; the owner from the environment made. Opened before the server
 *  listens; `attach` gives it the server's fixed address once it does. */
export async function openAccounts(options: AccountsOptions): Promise<Accounts> {
  if (options.secret !== undefined && (options.secret.length < 32 || /\s/.test(options.secret))) throw new Error("AGENTRUN_AUTH_SECRET must be 32 characters or more, with no whitespace");
  const secret = options.secret ?? (await secretIn(join(options.data, SECRET_FILE)));
  const file = join(options.data, AUTH_FILE);
  await writeFile(file, "", { flag: "a", mode: 0o600 });
  await chmod(file, 0o600);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    // Every migration in one transaction, before the server listens: a failed one leaves the database as it was.
    db.exec("BEGIN IMMEDIATE");
    try {
      await (await getMigrations(optionsOf(db, secret))).runMigrations();
      db.exec(`CREATE TABLE IF NOT EXISTS activity (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, principal_kind TEXT NOT NULL, principal_id TEXT,
        action TEXT NOT NULL, agent TEXT, revision TEXT, run TEXT);
        CREATE INDEX IF NOT EXISTS activity_agent ON activity (agent, seq);
        CREATE INDEX IF NOT EXISTS activity_run ON activity (run, seq);`);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    const accounts = new Accounts(db, secret, options.token);
    if (options.owner) await accounts.makeOwner(options.owner.email);
    return accounts;
  } catch (error) {
    db.close();
    throw error;
  }
}

export class Accounts {
  private auth: Auth | undefined;
  private site: { baseUrl: string; origin: string; origins: string[]; cookie: string } | undefined;
  private setupCode: { code: string; until: number; tries: number } | null = null;
  private settingUp = false;
  /** Sign-ins serve asked for and has not verified yet, by nonce: each takes its token from the plugin's callback. */
  private readonly pending = new Map<string, (token: string) => void>();

  /** `secret` is the library's: never a run's. */
  constructor(private readonly db: DatabaseSync, readonly secret: string, private readonly token: string) {}

  /** Fixes the address every link and the cookie are built from, and the origins a write may come from: `baseUrl`'s,
   *  and on the loopback default also localhost on the same port. Makes a fresh setup code when there is no
   *  owner: its link, or null. */
  attach(baseUrl: string, port: number, loopbackDefault = false): string | null {
    const origin = new URL(baseUrl).origin;
    const origins = loopbackDefault ? [...new Set([origin, `${new URL(baseUrl).protocol}//localhost:${port}`])] : [origin];
    this.auth = build(this.db, this.secret, { baseUrl, port, origins }, (nonce, token) => {
      if (typeof nonce === "string") this.pending.get(nonce)?.(token);
    });
    this.site = { baseUrl, origin, origins, cookie: sessionCookie(baseUrl, port) };
    if (this.hasOwner()) return null;
    this.setupCode = { code: randomBytes(16).toString("base64url"), until: Date.now() + SETUP_TTL_MS, tries: 0 };
    return `${baseUrl}/setup#code=${this.setupCode.code}`;
  }

  get origin(): string {
    return this.ready().origin;
  }

  /** Whether a request's Origin is one a write may come from: fixed at start, never taken from the request. */
  isOrigin(origin: string | undefined): boolean {
    return origin !== undefined && this.ready().origins.includes(origin);
  }

  close(): void {
    this.db.close();
  }

  private ready() {
    if (!this.site || !this.auth) throw new ApiError("unavailable", "the server is starting");
    return { ...this.site, auth: this.auth };
  }

  hasOwner(): boolean {
    return this.db.prepare(`SELECT 1 FROM "user" WHERE owner = 1 LIMIT 1`).get() !== undefined;
  }

  /** A person made server-side, the way in until invites. */
  addPerson(person: NewPerson): Promise<{ id: string }> {
    return this.make(person, this.ready().auth, false);
  }

  /** The owner from the environment, made at start when there is none, before the server has an address. */
  async makeOwner(email: string): Promise<void> {
    if (!this.hasOwner()) await this.make({ email, name: email.split("@")[0]!, role: "admin" }, build(this.db, this.secret), true);
  }

  /** The admin plugin's createUser with no password makes the user and no credential account: nobody's hash is kept. */
  private async make(person: NewPerson, auth: Auth, owner: boolean): Promise<{ id: string; email: string }> {
    const { user } = await auth.api.createUser({ body: { email: person.email, name: person.name, role: person.role } });
    if (owner) await (await auth.$context).internalAdapter.updateUser(user.id, { owner: true });
    return { id: user.id, email: user.email };
  }

  /** Signs in the person with `email`, who must exist, through the library's own magic-link sign-in run server-side:
   *  its Set-Cookie lines. The token never leaves this call. */
  async signIn(email: string, req?: IncomingMessage): Promise<string[]> {
    const { auth } = this.ready();
    const headers = signInHeaders(req);
    const nonce = randomBytes(16).toString("base64url");
    let token: string | undefined;
    this.pending.set(nonce, (given) => void (token = given));
    try {
      await auth.api.signInMagicLink({ body: { email, metadata: { nonce } }, headers });
    } finally {
      this.pending.delete(nonce);
    }
    if (token === undefined) throw new Error("the sign-in made no token");
    const verified = await auth.api.magicLinkVerify({ query: { token }, headers, returnHeaders: true }).catch((error: { headers?: Headers; message?: string }) => {
      // The plugin refuses by redirecting to an error page; its reason is in the address.
      const location = error.headers?.get?.("location");
      throw new Error(`the sign-in was refused: ${(location && new URL(location, "http://serve").searchParams.get("error")) || error.message || "unknown"}`);
    });
    const cookies = verified.headers.getSetCookie();
    if (!cookies.length) throw new Error("the sign-in set no session cookie");
    return cookies;
  }

  // ---- who is asking ----------------------------------------------------------------------------------------------

  private hasSessionCookie(req: IncomingMessage): boolean {
    const name = this.ready().cookie;
    return String(req.headers.cookie ?? "").split(";").some((part) => part.trim().startsWith(`${name}=`));
  }

  /** The person signed in by the request's session cookie: none for a session past 30 days (deleted here) or a disabled
   *  person. A refreshed session's cookie goes out on `res`. */
  async person(req: IncomingMessage, res?: ServerResponse): Promise<Principal | null> {
    if (!this.hasSessionCookie(req)) return null;
    const { auth } = this.ready();
    const found = await auth.api.getSession({ headers: headersOf(req), returnHeaders: true, ...(res ? {} : { query: { disableRefresh: true } }) });
    const session = found.response;
    if (!session) return null;
    if (Date.now() - new Date(session.session.createdAt).getTime() > MAX_SESSION_MS) {
      await (await auth.$context).internalAdapter.deleteSession(session.session.token);
      return null;
    }
    const user = session.user as typeof session.user & { role?: string | null; banned?: boolean | null };
    if (user.banned) return null;
    for (const cookie of found.headers.getSetCookie()) res?.appendHeader("set-cookie", cookie);
    return { kind: "person", id: user.id, role: roleOf(user.role) };
  }

  /** The write gate for a request a cookie authenticates: this server's Origin, then a JSON body. */
  checkWrite(req: IncomingMessage): void {
    if (req.method === "GET" || req.method === "HEAD") return;
    if (!this.isOrigin(req.headers.origin)) throw new ApiError("forbidden", `a write signed in by a cookie must come from ${this.ready().origins.join(" or ")}`);
    if (!isJson(req)) throw new ApiError("unsupported_media_type", "the body must be application/json");
  }

  // ---- the library's endpoints --------------------------------------------------------------------------------------

  /** A request under /v2/auth: an allowlisted endpoint with its method, past the write gate, to the library. */
  async forward(req: IncomingMessage, res: ServerResponse, raw: string, search: string): Promise<void> {
    const { auth, baseUrl } = this.ready();
    const path = raw.slice(BASE_PATH.length);
    const method = Object.hasOwn(ENDPOINTS, path) ? ENDPOINTS[path] : undefined;
    if (!method) throw new ApiError("not_found", `no route ${raw}`);
    if (req.method !== method) throw new ApiError("method_not_allowed", `${req.method} is not a method of ${raw}`, {}, { allow: method });
    // The 30-day limit holds here too: a session past it is deleted before the library sees it.
    await this.person(req);
    let body: string | undefined;
    if (method !== "GET") {
      this.checkWrite(req);
      const value = await jsonBody(req);
      if (path === "/update-user") {
        const extra = Object.keys(value).filter((key) => key !== "name");
        if (extra.length) throw invalid(extra.map((key) => ({ field: key, reason: "not_allowed", message: `update-user sets the name only; ${key} is not one of yours to set.` })));
      }
      body = JSON.stringify(value);
    }
    const answer = await auth.handler(new Request(`${baseUrl}${raw}${search}`, { method, headers: headersOf(req), ...(body === undefined ? {} : { body }) }));
    const headers: Record<string, string | string[]> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    answer.headers.forEach((value, name) => void (name !== "set-cookie" && (headers[name] = value)));
    const cookies = answer.headers.getSetCookie();
    if (cookies.length) headers["set-cookie"] = cookies;
    let bytes = Buffer.from(await answer.arrayBuffer());
    // The library answers a session's token in its JSON too; a page's script must never read it.
    if (String(answer.headers.get("content-type")).startsWith("application/json") && bytes.length) {
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      if (value !== null && typeof value === "object") {
        delete (value as { token?: unknown }).token;
        delete ((value as { session?: { token?: unknown } }).session ?? {}).token;
      }
      bytes = Buffer.from(JSON.stringify(value));
    }
    delete headers["content-length"];
    res.writeHead(answer.status, { ...headers, "content-length": String(bytes.length) });
    res.end(req.method === "HEAD" ? undefined : bytes);
  }

  // ---- setup --------------------------------------------------------------------------------------------------------

  /** POST /v2/setup {code, name, email}: the owner, made with the code from the server's log (or the token as a Bearer),
   *  and signed in on the 201. */
  async setup(req: IncomingMessage, res: ServerResponse): Promise<{ status: number; body: unknown }> {
    const { origins } = this.ready();
    const bearer = req.headers.authorization;
    if (bearer !== undefined && !same(bearer, `Bearer ${this.token}`)) throw new ApiError("unauthenticated", "the Bearer here is the server's token, or none", {}, { "www-authenticate": "Bearer" });
    const byToken = bearer !== undefined;
    if (!byToken && !this.isOrigin(req.headers.origin)) throw new ApiError("forbidden", `setup must come from ${origins.join(" or ")}`);
    if (this.hasOwner() || this.settingUp) throw new ApiError("forbidden", "this server has an owner, or is being set up: sign in");
    // Taken with nothing awaited since the check, so a setup arriving meanwhile is refused whatever its body says.
    this.settingUp = true;
    try {
      return await this.makeFirstOwner(req, res, byToken);
    } finally {
      this.settingUp = false;
    }
  }

  private async makeFirstOwner(req: IncomingMessage, res: ServerResponse, byToken: boolean): Promise<{ status: number; body: unknown }> {
    const { auth } = this.ready();
    if (!isJson(req)) throw new ApiError("unsupported_media_type", "the body must be application/json");
    const body = await jsonBody(req);
    const issues: InputIssue[] = Object.keys(body).filter((key) => !["code", "name", "email"].includes(key)).map((key) => ({ field: key, reason: "not_allowed", message: key === "password" ? "This server keeps no passwords." : `The body keeps no field ${key}.` }));
    const { name, email } = body;
    if (typeof name !== "string" || !name.trim() || name.length > 100) issues.push({ field: "name", reason: name === undefined ? "missing" : "wrong_type", message: "name is 1 to 100 characters" });
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) issues.push({ field: "email", reason: email === undefined ? "missing" : "wrong_type", message: "email is an email address" });
    if (issues.length) throw invalid(issues);
    // A refused form keeps the code; a matching code is spent here, before the owner is made.
    const code = this.setupCode;
    if (!byToken) this.spendCode(body.code);
    const made = await this.make({ email: email as string, name: (name as string).trim(), role: "admin" }, auth, true);
    let cookies: string[];
    try {
      cookies = await this.signIn(made.email, req);
    } catch (error) {
      // An owner nobody can sign in as would shut setup for good: undone, with the code good again.
      await (await auth.$context).internalAdapter.deleteUser(made.id);
      this.setupCode = code;
      throw error;
    }
    this.setupCode = null;
    for (const cookie of cookies) res.appendHeader("set-cookie", cookie);
    return { status: 201, body: this.view(this.row(made.id)!) };
  }

  private spendCode(given: unknown): void {
    const setup = this.setupCode;
    if (!setup || Date.now() > setup.until) {
      this.setupCode = null;
      throw new ApiError("forbidden", "the setup code is spent or expired: restart the server for a new one");
    }
    if (typeof given === "string" && same(given, setup.code)) {
      this.setupCode = null;
      return;
    }
    if (++setup.tries >= SETUP_TRIES) this.setupCode = null;
    throw new ApiError("forbidden", "that is not the setup code in the server's log");
  }

  // ---- people -------------------------------------------------------------------------------------------------------

  private row(id: string): Person | undefined {
    return this.db.prepare(`SELECT id, name, email, role, owner, banned, createdAt FROM "user" WHERE id = ?`).get(id) as Person | undefined;
  }

  private view(person: Person) {
    return { id: person.id, name: person.name, email: person.email, role: roleOf(person.role), owner: Boolean(person.owner), disabled: Boolean(person.banned), created_at: iso(person.createdAt) };
  }

  me(principal: Principal) {
    if (principal.kind === "token") return { kind: "token", id: null, name: null, email: null, role: principal.role, owner: false };
    return { kind: "person", ...this.view(this.row(principal.id)!) };
  }

  people() {
    return { people: (this.db.prepare(`SELECT id, name, email, role, owner, banned, createdAt FROM "user" ORDER BY createdAt, id`).all() as Person[]).map((person) => this.view(person)) };
  }

  /** An admin sets another person's role or disables them; either ends all of that person's sessions. */
  async updatePerson(principal: Principal, id: string, body: Record<string, unknown>) {
    const { auth } = this.ready();
    const issues: InputIssue[] = Object.keys(body).filter((key) => key !== "role" && key !== "disabled").map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member") issues.push({ field: "role", reason: "not_an_option", message: "role is admin or member" });
    if (body.disabled !== undefined && typeof body.disabled !== "boolean") issues.push({ field: "disabled", reason: "wrong_type", message: "disabled is true or false" });
    if (!issues.length && body.role === undefined && body.disabled === undefined) issues.push({ field: "role", reason: "missing", message: "set role, disabled or both" });
    if (issues.length) throw invalid(issues);
    const person = this.row(id);
    if (!person) throw new ApiError("not_found", `no person ${id}`);
    if (principal.kind === "person" && principal.id === id) throw new ApiError("forbidden", "nobody sets their own role or disables themselves");
    if (person.owner && (body.role === "member" || body.disabled === true)) throw new ApiError("forbidden", "the owner can never be disabled or demoted");
    const { internalAdapter } = await auth.$context;
    const role = body.role as Role | undefined;
    const disabled = body.disabled as boolean | undefined;
    const changed = (role !== undefined && role !== roleOf(person.role)) || (disabled !== undefined && disabled !== Boolean(person.banned));
    if (changed) {
      await internalAdapter.updateUser(id, { ...(role === undefined ? {} : { role }), ...(disabled === undefined ? {} : { banned: disabled, banReason: null }) });
      await internalAdapter.deleteUserSessions(id);
    }
    return this.view(this.row(id)!);
  }

  // ---- who did it ---------------------------------------------------------------------------------------------------

  record(principal: Principal, action: string, refs: { agent?: string; revision?: string | null; run?: string }): void {
    this.db
      .prepare("INSERT INTO activity (at, principal_kind, principal_id, action, agent, revision, run) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), principal.kind, principal.kind === "person" ? principal.id : null, action, refs.agent ?? null, refs.revision ?? null, refs.run ?? null);
  }

  private byOf(kind: string, id: string | null, names: Map<string, string>) {
    return kind === "person" ? { kind, id, name: names.get(id!) ?? null } : { kind, id: null, name: null };
  }

  private names(): Map<string, string> {
    return new Map((this.db.prepare(`SELECT id, name FROM "user"`).all() as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  }

  /** Who made each of these revisions; a revision from before accounts has no one. */
  revisionsBy(revisions: string[]) {
    if (!revisions.length) return new Map();
    const names = this.names();
    const rows = this.db.prepare(`SELECT revision, principal_kind, principal_id FROM activity WHERE action IN ('agent.create', 'agent.update') AND revision IN (${revisions.map(() => "?").join(", ")})`).all(...revisions) as { revision: string; principal_kind: string; principal_id: string | null }[];
    return new Map(rows.map((row) => [row.revision, this.byOf(row.principal_kind, row.principal_id, names)]));
  }

  /** Newest first: `run` narrows it to one run, `agent` to one agent. */
  activity(filter: { run?: string; agent?: string }, offset: number, limit: number) {
    const where = filter.run !== undefined ? "WHERE run = ?" : filter.agent !== undefined ? "WHERE agent = ?" : "";
    const args = filter.run !== undefined ? [filter.run] : filter.agent !== undefined ? [filter.agent] : [];
    const total = (this.db.prepare(`SELECT count(*) AS n FROM activity ${where}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM activity ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as { at: string; principal_kind: string; principal_id: string | null; action: string; agent: string | null; revision: string | null; run: string | null }[];
    const names = this.names();
    return { total, entries: rows.map((row) => ({ at: row.at, by: this.byOf(row.principal_kind, row.principal_id, names), action: row.action, agent_id: row.agent, revision: row.revision, run_id: row.run })) };
  }
}
