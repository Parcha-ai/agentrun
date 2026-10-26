// Accounts, behind AGENTRUN_ACCOUNTS=1: people with a password and a role, kept by Better Auth on node:sqlite in
// DIR/auth.sqlite. Serve keeps what the library does not: the setup code, the allowlist of its endpoints, the one write
// gate (this server's Origin and a JSON body), the 30-day limit on a session, and the activity log.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins/admin";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
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
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 128;
const MAX_BODY = 1 << 16;

/** The library's endpoints a client may call, each with its one method. Every other path under /v2/auth is a 404, and
 *  no sign-up is among them: the owner is made by serve. */
const ENDPOINTS: Record<string, string> = {
  "/sign-in/email": "POST",
  "/sign-out": "POST",
  "/get-session": "GET",
  "/change-password": "POST",
  "/list-sessions": "GET",
  "/revoke-session": "POST",
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
  owner?: { email: string; passwordFile: string };
};

export type NewPerson = { email: string; name: string; password: string; role: Role };
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

function optionsOf(db: DatabaseSync, secret: string, site?: { baseUrl: string; port: number }) {
  const https = site?.baseUrl.startsWith("https://") ?? false;
  const name = https ? "__Host-agentrun-session" : `agentrun-${site?.port ?? 0}-session`;
  return {
    appName: "AgentRun Server",
    database: db,
    secret,
    baseURL: site?.baseUrl ?? "http://127.0.0.1",
    basePath: BASE_PATH,
    trustedOrigins: site ? [new URL(site.baseUrl).origin] : [],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: MIN_PASSWORD, maxPasswordLength: MAX_PASSWORD },
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
    plugins: [admin({ defaultRole: "member", adminRoles: ["admin"], roles: { admin: adminAc, member: userAc } })],
    telemetry: { enabled: false },
    logger: { level: "error" as const, log: (_level: string, message: string) => void process.stderr.write(`agentrun-serve: accounts: ${message}\n`) },
  };
}
const build = (db: DatabaseSync, secret: string, site?: { baseUrl: string; port: number }) => betterAuth(optionsOf(db, secret, site));
type Auth = ReturnType<typeof build>;

/** The accounts database, migrated, with its secret; the owner from the environment made. Opened before the server
 *  listens; `attach` gives it the server's fixed address once it does. */
export async function openAccounts(options: AccountsOptions): Promise<Accounts> {
  if (options.secret !== undefined && (options.secret.length < 32 || /\s/.test(options.secret))) throw new Error("AGENTRUN_AUTH_SECRET must be 32 characters or more, with no whitespace");
  let ownerPassword: string | undefined;
  if (options.owner) {
    ownerPassword = (await readFile(options.owner.passwordFile, "utf8").catch((error: Error) => {
      throw new Error(`AGENTRUN_OWNER_PASSWORD_FILE: ${error.message}`);
    })).replace(/\r?\n$/, "");
    if (ownerPassword.length < MIN_PASSWORD || ownerPassword.length > MAX_PASSWORD) throw new Error(`the owner's password (AGENTRUN_OWNER_PASSWORD_FILE) must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`);
  }
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
    if (options.owner && !accounts.hasOwner()) await accounts.make({ email: options.owner.email, name: options.owner.email.split("@")[0]!, password: ownerPassword!, role: "admin" }, build(db, secret), true);
    return accounts;
  } catch (error) {
    db.close();
    throw error;
  }
}

export class Accounts {
  private auth: Auth | undefined;
  private site: { baseUrl: string; origin: string; cookie: string } | undefined;
  private setupCode: { code: string; until: number; tries: number } | null = null;
  private settingUp = false;

  /** `secret` is the library's: never a run's. */
  constructor(private readonly db: DatabaseSync, readonly secret: string, private readonly token: string) {}

  /** Fixes the address every link and the cookie are built from, and makes a fresh setup code when there is no owner:
   *  its link, or null. */
  attach(baseUrl: string, port: number): string | null {
    this.auth = build(this.db, this.secret, { baseUrl, port });
    this.site = { baseUrl, origin: new URL(baseUrl).origin, cookie: baseUrl.startsWith("https://") ? "__Host-agentrun-session" : `agentrun-${port}-session` };
    if (this.hasOwner()) return null;
    this.setupCode = { code: randomBytes(16).toString("base64url"), until: Date.now() + SETUP_TTL_MS, tries: 0 };
    return `${baseUrl}/setup#code=${this.setupCode.code}`;
  }

  get origin(): string {
    return this.ready().origin;
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

  async make(person: NewPerson, auth: Auth, owner: boolean): Promise<{ id: string }> {
    const { user } = await auth.api.createUser({ body: { email: person.email, name: person.name, password: person.password, role: person.role } });
    if (owner) await (await auth.$context).internalAdapter.updateUser(user.id, { owner: true });
    return { id: user.id };
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
    if (req.headers.origin !== this.ready().origin) throw new ApiError("forbidden", `a write signed in by a cookie must come from ${this.ready().origin}`);
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
      // A new password ends every other session of the person.
      if (path === "/change-password") value.revokeOtherSessions = true;
      body = JSON.stringify(value);
    }
    const answer = await auth.handler(new Request(`${baseUrl}${raw}${search}`, { method, headers: headersOf(req), ...(body === undefined ? {} : { body }) }));
    const headers: Record<string, string | string[]> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    answer.headers.forEach((value, name) => void (name !== "set-cookie" && (headers[name] = value)));
    const cookies = answer.headers.getSetCookie();
    if (cookies.length) headers["set-cookie"] = cookies;
    const bytes = Buffer.from(await answer.arrayBuffer());
    delete headers["content-length"];
    res.writeHead(answer.status, { ...headers, "content-length": String(bytes.length) });
    res.end(req.method === "HEAD" ? undefined : bytes);
  }

  // ---- setup --------------------------------------------------------------------------------------------------------

  /** POST /v2/setup: the owner, made with the code from the server's log (or the token as a Bearer), and signed in. */
  async setup(req: IncomingMessage, res: ServerResponse): Promise<{ status: number; body: unknown }> {
    const { auth, origin } = this.ready();
    const bearer = req.headers.authorization;
    if (bearer !== undefined && !same(bearer, `Bearer ${this.token}`)) throw new ApiError("unauthenticated", "the Bearer here is the server's token, or none", {}, { "www-authenticate": "Bearer" });
    const byToken = bearer !== undefined;
    if (!byToken && req.headers.origin !== origin) throw new ApiError("forbidden", `setup must come from ${origin}`);
    if (this.hasOwner() || this.settingUp) throw new ApiError("already_set_up", "this server has an owner: sign in");
    if (!isJson(req)) throw new ApiError("unsupported_media_type", "the body must be application/json");
    const body = await jsonBody(req);
    if (!byToken) this.spendCode(body.code);
    const issues: InputIssue[] = Object.keys(body).filter((key) => !["code", "name", "email", "password"].includes(key)).map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
    const { name, email, password } = body;
    if (typeof name !== "string" || !name.trim() || name.length > 100) issues.push({ field: "name", reason: name === undefined ? "missing" : "wrong_type", message: "name is 1 to 100 characters" });
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) issues.push({ field: "email", reason: email === undefined ? "missing" : "wrong_type", message: "email is an email address" });
    if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) issues.push({ field: "password", reason: password === undefined ? "missing" : "too_short", message: `password is ${MIN_PASSWORD} to ${MAX_PASSWORD} characters` });
    if (issues.length) throw invalid(issues);
    this.settingUp = true;
    try {
      if (this.hasOwner()) throw new ApiError("already_set_up", "this server has an owner: sign in");
      const { id } = await this.make({ email: email as string, name: (name as string).trim(), password: password as string, role: "admin" }, auth, true);
      this.setupCode = null;
      const signedIn = await auth.api.signInEmail({ body: { email: email as string, password: password as string }, headers: headersOf(req), returnHeaders: true });
      for (const cookie of signedIn.headers.getSetCookie()) res.appendHeader("set-cookie", cookie);
      return { status: 201, body: this.view(this.row(id)!) };
    } finally {
      this.settingUp = false;
    }
  }

  private spendCode(given: unknown): void {
    const setup = this.setupCode;
    if (!setup || Date.now() > setup.until) {
      this.setupCode = null;
      throw new ApiError("forbidden", "the setup code is spent or expired: restart the server for a new one");
    }
    if (typeof given === "string" && same(given, setup.code)) return;
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
