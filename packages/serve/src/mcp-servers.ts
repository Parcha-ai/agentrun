// Remote MCP servers a person adds through /v2/settings/mcp-servers. A preview connects with the official SDK client
// (@modelcontextprotocol/client: 2026-07-28 first, 2025-era servers by its fallback), lists every tool and stores
// nothing. A save previews, then keeps the URL, the tool snapshot the person saw and the credential in
// DIR/mcp-servers.json (0600, written whole, synced, renamed), each header value sealed (AES-256-GCM, tool-keys.ts' seal
// key) and bound to `mcp:<server>:<header>`, so a value moved to another server or header does not open. An OAuth
// server's token set (mcp-oauth.ts) is sealed the same way, bound to `mcp:<server>:oauth`, and refreshed here. No read
// returns a credential. No redirect is followed: a credential goes only to the URL the person gave.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, invalid, type InputIssue } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { metaToolOf } from "./mcp-meta.js";
import { type ClientKind, MCP_SETTINGS_PAGE, McpSignIns, type OAuthNetwork, systemNetwork, reasonOf, refreshed, refused, SIGN_IN_AGAIN, type TokenSet } from "./mcp-oauth.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { isObject, unknownFields } from "./validate.js";

export const MCP_SERVERS_FILE = "mcp-servers.json";
const FORMAT = "mcp-servers/1";
export const MCP_SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** The names AgentRun's own tools are called by, which no MCP server takes: claude-agent calls the kernel's host tools
 *  as `mcp__hands__<tool>`, and monid's are `monid_<tool>` (tool-gate.ts settingsKeyOf reads both as AgentRun's). */
export const RESERVED_MCP_NAMES: readonly string[] = ["hands", "monid"];
export const MCP_AUTH_TYPES = ["none", "bearer", "headers", "oauth"] as const;
/** A run's launch refreshes an OAuth access token that expires within this. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** How long a stop waits for the refreshes and code exchanges it aborted. */
const CLOSE_MS = 2_000;
/** How long an access token given with no expiry is taken to last: it is refreshed within the margin of then. */
const UNKNOWN_EXPIRY_MS = 60 * 60_000;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;
const REQUEST_MS = 15_000;
const PREVIEW_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 2 ** 20;
const MAX_URL = 2048;
const MAX_VALUE_BYTES = 8192;
const MAX_HEADERS = 8;
/** What one server's snapshot may hold: every list and get reads it back whole. */
const MAX_TOOLS = 500;
const MAX_SNAPSHOT_BYTES = 2 ** 20;
const MAX_PAGES = 64;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Headers the transport sets itself, or that name the connection rather than the person. */
const RESERVED = new Set(["accept", "connection", "content-length", "content-type", "host", "last-event-id", "mcp-method", "mcp-name", "mcp-protocol-version", "mcp-session-id", "transfer-encoding"]);
const LOOPBACK_V4 = /^127(?:[.]\d{1,3}){3}$/;
const LOOPBACK_NAMES = ["localhost", "[::1]"]; // key-gate: loopback-rule plain http is allowed only to these hosts
const LOOPBACK = (host: string) => LOOPBACK_NAMES.includes(host) || LOOPBACK_V4.test(host);

type AuthType = (typeof MCP_AUTH_TYPES)[number];
export type McpTool = { name: string; title?: string; description?: string; input_schema: unknown; output_schema?: unknown; annotations?: unknown };
type Listed = { protocol: string; server_info: unknown; instructions?: string; tools: McpTool[] };
/** An OAuth sign-in, what may be shown of it: never a token. */
type OAuthNote = { expires_at?: string; scopes: string[]; client: ClientKind; client_id?: string; expired?: true };
/** A tool's declared price in USD a call, by its name: what a run's cap holds and books for each call (mcp-gateway.ts). */
export type McpPrices = Record<string, number>;
type Kept = Listed & { url: string; auth: { type: AuthType; sealed?: Record<string, string>; check?: string; oauth?: OAuthNote }; prices?: McpPrices; listed_at: string; updated_at: string };
type HeaderMap = Record<string, string>;
type Auth = { type: AuthType; headers?: HeaderMap };

export class McpServers {
  readonly file: string;
  private readonly key: Buffer | undefined;
  private readonly sealCheck: string | undefined;
  private readonly signIns: McpSignIns;
  /** Each OAuth server's refresh under way: one at a time, so a rotating refresh token is spent once. */
  private readonly refreshing = new Map<string, Promise<void>>();
  /** The server's stop: aborts every refresh and code exchange under way, and from then on nothing is written. */
  private readonly stopped = new AbortController();
  /** The refreshes and callbacks under way, which close() waits out before the server lets its data directory go. */
  private readonly inflight = new Set<Promise<unknown>>();

  /** `network`: how an MCP server off loopback's authorization server is reached (mcp-oauth.ts); tests give their own. */
  constructor(data: string, env: NodeJS.ProcessEnv, private readonly version: string, private readonly network: OAuthNetwork = systemNetwork) {
    this.signIns = new McpSignIns(network);
    this.file = join(data, MCP_SERVERS_FILE);
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    this.sealCheck = this.key && createHmac("sha256", this.key).update(`agentrun-serve ${FORMAT} key check`).digest("base64url");
  }

  get atRest(): "sealed" | "unavailable" {
    return this.key ? "sealed" : "unavailable";
  }

  /** This server's address as a browser reaches it: an OAuth sign-in's callback is under it. */
  attach(base: string): void {
    this.signIns.base = base.replace(/\/+$/, "");
  }

  clientDocument() {
    return this.signIns.clientDocument();
  }

  /** The origin the authorization server sends the browser back to: a sign-in starts there, where its cookie is set. */
  get callbackOrigin(): string {
    return new URL(this.signIns.base).origin;
  }

  /** At the server's stop, before its data directory's lock goes: every refresh and code exchange under way is aborted
   *  and waited for (at most `boundMs`), and no write is made after. One aborted writes nothing, so the token set stays
   *  as it was; if its authorization server had already rotated the refresh token, the next start's refresh is refused
   *  and the server reads `credential: expired`, asking for a sign-in again. */
  async close(boundMs = CLOSE_MS): Promise<void> {
    this.stopped.abort();
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((done) => setTimeout(done, boundMs).unref())]);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    void work.then(() => this.inflight.delete(work), () => this.inflight.delete(work));
    return work;
  }

  list() {
    const servers = this.kept();
    if (servers === "unreadable") return { servers: [], file_unreadable: true as const };
    return { servers: Object.keys(servers).sort().map((name) => this.view(name, servers[name]!)) };
  }

  get(name: string) {
    return this.view(name, this.need(name));
  }

  /** POST preview: `{url, auth}`, or `{name}` for a saved server with its sealed credential. Stores nothing. */
  async preview(body: Record<string, unknown>, stop?: AbortSignal): Promise<Listed> {
    if (body.name !== undefined && body.url === undefined) {
      const issues = unknownFields(body, ["name"]);
      if (issues.length) throw invalid(issues);
      const name = String(body.name);
      await this.freshen(name);
      const kept = this.need(name);
      return marked(kept.url, await listServer(new URL(kept.url), this.opened(name, kept, "name"), this.version, stop));
    }
    const { url, auth } = this.admit(body);
    if (auth.type !== "none" && !auth.headers) throw invalid([credentialMissing(auth.type, "A preview needs the credential it is to connect with.")]);
    return marked(url.href, await listServer(url, auth.headers ?? {}, this.version, stop));
  }

  /** PUT: preview, then keep the server with the tools listed. A body with no credential keeps the sealed one, while
   *  the auth type and the URL's origin stay the same. */
  async save(name: string, body: Record<string, unknown>, stop?: AbortSignal) {
    nameOf(name);
    const { url, auth, prices } = this.admit(body, true);
    if (auth.type !== "none" && !this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no MCP server credential: it never keeps one in the clear. ${SEAL_KEY_HOW}`);
    const was = this.servers()[name];
    let headers = auth.headers;
    if (auth.type !== "none" && !headers) {
      if (!was || was.auth.type !== auth.type) throw invalid([credentialMissing(auth.type, `The server ${name} has no saved ${auth.type} credential to keep.`)]);
      if (new URL(was.url).origin !== url.origin) throw invalid([credentialMissing(auth.type, `The address moved from ${new URL(was.url).origin} to ${url.origin}: send the credential again, so a saved one never goes to another origin.`)]);
      await this.freshen(name);
      // Read again after the refresh's wait: a sign-in to another URL that landed meanwhile is never sent here.
      const now = this.need(name);
      if (saving(now) !== saving(was)) throw new ApiError("unavailable", `The server ${name} was signed in to, saved or forgotten meanwhile: save it again.`);
      headers = this.opened(name, now, credentialMissing(auth.type, "").field);
    }
    const listed = await listServer(url, headers ?? {}, this.version, stop);
    // A price names a tool the server listed now, or nothing is saved.
    const unlisted = Object.keys(prices ?? {}).filter((tool) => !listed.tools.some((listedTool) => listedTool.name === tool));
    if (unlisted.length) throw invalid(unlisted.map((tool) => ({ field: `prices.${tool}`, reason: "not_an_option", message: `The server ${name} lists no tool ${tool}; its tools are ${listed.tools.map((t) => t.name).join(", ") || "none"}.` })));
    const now = new Date().toISOString();
    const sealed = auth.type !== "oauth" && headers && Object.fromEntries(Object.entries(headers).map(([header, value]) => [header, seal(this.key!, Buffer.from(value, "utf8"), aad(name, header)).toString("base64")]));
    const servers = this.servers();
    // An OAuth server keeps its token set as sealed (a refresh meanwhile kept); only a sign-in replaces it, and one that
    // lands, or a PUT or DELETE, while this listed makes the listing stale: its token never goes with another URL.
    if (auth.type === "oauth" && (!servers[name] || saving(servers[name]) !== saving(was!))) throw new ApiError("unavailable", `The server ${name} was signed in to, saved or forgotten while its tools were listed: save it again.`);
    const kept = auth.type === "oauth" ? servers[name]!.auth : { type: auth.type, ...(sealed ? { sealed, check: this.sealCheck } : {}) };
    servers[name] = { url: url.href, auth: kept, ...listed, ...(prices && Object.keys(prices).length ? { prices } : {}), listed_at: now, updated_at: now };
    this.write(servers);
    return this.view(name, servers[name]);
  }

  /** POST refresh: list the saved server's tools again, keep them, and say what was added, removed and changed. */
  async refresh(name: string, stop?: AbortSignal) {
    await this.freshen(name);
    const was = this.need(name);
    const listed = await listServer(new URL(was.url), this.opened(name, was, "name"), this.version, stop);
    const servers = this.servers();
    const now = servers[name];
    if (!now) throw notFound(name);
    // A PUT while listing (another URL, another account's credential) makes this listing stale: never kept.
    if (canonical([now.url, now.auth, now.updated_at]) !== canonical([was.url, was.auth, was.updated_at])) throw new ApiError("unavailable", `The server ${name} was changed while its tools were listed: refresh it again.`);
    const before = new Map(now.tools.map((tool) => [tool.name, canonical(tool)]));
    const after = new Map(listed.tools.map((tool) => [tool.name, canonical(tool)]));
    const next: Kept = { ...now, ...listed, listed_at: new Date().toISOString() };
    // A price of a tool the server no longer lists goes with it.
    const prices = Object.entries(now.prices ?? {}).filter(([tool]) => after.has(tool));
    if (prices.length) next.prices = Object.fromEntries(prices);
    else delete next.prices;
    servers[name] = next;
    this.write(servers);
    return {
      added: [...after.keys()].filter((tool) => !before.has(tool)),
      removed: [...before.keys()].filter((tool) => !after.has(tool)),
      changed: [...after.keys()].filter((tool) => before.has(tool) && before.get(tool) !== after.get(tool)),
      server: this.view(name, servers[name]!),
    };
  }

  /** POST .../{name}/oauth/start: `{url, scopes?, client_id?, client_secret?}`; answers the URL the owner opens. */
  async oauthStart(name: string, body: Record<string, unknown>): Promise<{ authorization_url: string }> {
    nameOf(name);
    const issues = unknownFields(body, ["url", "scopes", "client_id", "client_secret"]);
    const url = urlOf(body.url, issues);
    const { scopes, client_id, client_secret } = body;
    if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.length || scopes.length > 32 || !scopes.every((scope) => typeof scope === "string" && SCOPE.test(scope)))) issues.push({ field: "scopes", reason: "invalid", message: "scopes is a list of 1 to 32 OAuth scopes." });
    for (const [field, text] of [["client_id", client_id], ["client_secret", client_secret]] as const)
      if (text !== undefined && (typeof text !== "string" || text === "" || CONTROL.test(text) || Buffer.byteLength(text) > MAX_VALUE_BYTES)) issues.push({ field, reason: "invalid", message: `${field} is text, at most ${MAX_VALUE_BYTES} bytes.` });
    if (client_secret !== undefined && client_id === undefined) issues.push({ field: "client_id", reason: "missing", message: "A client_secret goes with the client_id it is the secret of." });
    if (issues.length) throw invalid(issues);
    if (!this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no MCP server credential: it never keeps one in the clear. ${SEAL_KEY_HOW}`);
    const was = this.servers()[name];
    // A body with no client_id signs in again with the client kept in the sealed token set (a pre-registered one with
    // its secret, or the one registered or named last time), for the same origin only; one with a client_id replaces it.
    const opened = typeof client_id !== "string" && was?.auth.type === "oauth" && new URL(was.url).origin === url!.origin ? this.open(name, was) : undefined;
    const kept = opened && "set" in opened ? opened.set : undefined;
    const client = typeof client_id === "string" ? { client: { client_id, ...(typeof client_secret === "string" ? { client_secret } : {}) }, kind: "pre-registered" as const } : kept ? { client: kept.client, kind: kept.kind } : {};
    return { authorization_url: await this.signIns.start(name, url!, { was: was ? saving(was) : null, ...(scopes ? { scope: (scopes as string[]).join(" ") } : {}), ...client }) };
  }

  /** GET .../oauth/callback, the browser's way back: its state's sign-in finished (the code exchanged, the token set
   *  sealed, the tools listed and kept). Answers where to send the browser; 400 for a state that is unknown, used or
   *  expired. */
  oauthCallback(query: URLSearchParams, stop?: AbortSignal): Promise<string> {
    return this.track(this.callback(query, AbortSignal.any([this.stopped.signal, ...(stop ? [stop] : [])])));
  }

  private async callback(query: URLSearchParams, stop: AbortSignal): Promise<string> {
    const entry = this.signIns.take(query.get("state"));
    const stale = (servers: Record<string, Kept>) => (servers[entry.name] ? saving(servers[entry.name]!) : null) !== entry.was;
    const back = (error?: string) => `${MCP_SETTINGS_PAGE}?server=${entry.name}&sign_in=${error ? `failed&error=${error}` : "ok"}`;
    try {
      const error = query.get("error");
      if (error) return back(/^[a-z_]{1,64}$/.test(error) ? error : "sign_in_failed");
      const set = await this.signIns.finish(entry, query.get("code") ?? "", query.get("iss") ?? undefined, stop);
      const listed = await listServer(new URL(entry.url), { authorization: `Bearer ${set.tokens.access_token}` }, this.version, stop);
      const servers = this.servers();
      // Saved, signed in to again or forgotten since this sign-in started: that stands.
      if (stale(servers)) return back("changed_meanwhile");
      const now = new Date().toISOString();
      // The tools' prices stay with a sign-in again to the same address.
      const prices = servers[entry.name]?.url === entry.url ? servers[entry.name]!.prices : undefined;
      servers[entry.name] = { url: entry.url, auth: this.sealedSet(entry.name, set), ...listed, ...(prices ? { prices } : {}), listed_at: now, updated_at: now };
      this.write(servers);
      return back();
    } catch (error) {
      return back(await reasonOf(error));
    }
  }

  /** A run's launch: the server's credential (headers), an OAuth access token refreshed first when it expires within
   *  `margin`. Undefined when it takes none; `{ unopened }` when it does not open, its sign-in expired among them. */
  async headersForRun(name: string, margin = REFRESH_MARGIN_MS): Promise<{ headers: HeaderMap } | { unopened: string } | undefined> {
    await this.freshen(name, margin);
    return this.headers(name);
  }

  /** The saved server's credential, opened, for a run's launch: its headers, or why it does not open, each under its own
   *  tag; undefined when it takes none. An OAuth sign-in that expired, or whose refresh was refused or had no refresh
   *  token left, is a credential that does not open: its calls are refused unsent, saying to sign in again. */
  headers(name: string): { headers: HeaderMap } | { unopened: string } | undefined {
    const kept = this.saved(name);
    if (!kept || kept.auth.type === "none") return undefined;
    if (kept.auth.oauth?.expired) return { unopened: `its sign-in expired or was revoked: ${SIGN_IN_AGAIN}` };
    const opened = this.open(name, kept);
    // Tagged, never told apart by a key a saved header could also have (`unopened` is a header name like any other).
    if ("headers" in opened) return { headers: opened.headers };
    return { unopened: opened.unreadable === "seal_key_missing" ? `this server was handed no seal key, ${SEAL_KEY_ENV}` : "sealed under another seal key, or damaged" };
  }

  /** An OAuth server's token set refreshed when its access token expires within `margin`. A refusal (revoked, expired)
   *  marks the sign-in expired; an authorization server out of reach leaves it as it is. It runs on exactly these
   *  paths: before a run's process is spawned (runs.ts mcpFresh: a start, a reopen, a relaunch after a crash, a
   *  message that brings the process up), and before a preview by name, a PUT that keeps the token set, and a POST
   *  refresh. Never on a stop or an abort, nor on a path that only reaches a live process. */
  private freshen(name: string, margin = REFRESH_MARGIN_MS): Promise<void> {
    const running = this.refreshing.get(name);
    if (running) return running;
    const kept = this.saved(name);
    if (this.stopped.signal.aborted || kept?.auth.type !== "oauth" || kept.auth.oauth?.expired) return Promise.resolve();
    const opened = this.open(name, kept);
    const set = "set" in opened ? opened.set : undefined;
    // An access token whose expiry was not given is taken to last UNKNOWN_EXPIRY_MS from when it was obtained.
    const due = set?.expires_at ? Date.parse(set.expires_at) : set?.obtained_at ? Date.parse(set.obtained_at) + UNKNOWN_EXPIRY_MS : undefined;
    if (!set || due === undefined || due - Date.now() > margin) return Promise.resolve();
    const run = (async () => {
      let next: TokenSet | undefined;
      let no = !set.tokens.refresh_token && !!set.expires_at && Date.parse(set.expires_at) <= Date.now();
      if (set.tokens.refresh_token) {
        try {
          next = await refreshed(set, kept.url, this.stopped.signal, this.network);
        } catch (error) {
          no = await refused(error);
        }
      }
      // Stopped while it waited: nothing is written, and the token set stays as it was.
      if (this.stopped.signal.aborted) return;
      const servers = this.kept();
      // Signed in again, or forgotten, while it refreshed: that stands.
      if (servers === "unreadable" || servers[name]?.auth.sealed?.oauth !== kept.auth.sealed?.oauth || (!next && !no)) return;
      // Only the credential changes: a PUT that saved meanwhile (same token set) keeps its URL and tools.
      const now = servers[name]!;
      servers[name] = { ...now, auth: next ? this.sealedSet(name, next) : { ...now.auth, oauth: { ...now.auth.oauth!, expired: true } } };
      this.write(servers);
    })().finally(() => this.refreshing.delete(name));
    this.track(run);
    this.refreshing.set(name, run);
    return run;
  }

  private sealedSet(name: string, set: TokenSet): Kept["auth"] {
    const oauth = seal(this.key!, Buffer.from(JSON.stringify(set), "utf8"), aad(name, "oauth")).toString("base64");
    const note: OAuthNote = { ...(set.expires_at ? { expires_at: set.expires_at } : {}), scopes: (set.tokens.scope ?? "").split(" ").filter(Boolean), client: set.kind, client_id: set.client.client_id };
    return { type: "oauth", sealed: { oauth }, check: this.sealCheck, oauth: note };
  }

  remove(name: string): void {
    const servers = this.servers();
    if (!servers[name]) throw notFound(name);
    delete servers[name];
    this.write(servers);
  }

  private saved(name: string): Kept | undefined {
    const kept = this.kept();
    return kept === "unreadable" || !Object.hasOwn(kept, name) ? undefined : kept[name];
  }

  private need(name: string): Kept {
    const kept = this.servers()[name];
    if (!kept) throw notFound(name);
    return kept;
  }

  private view(name: string, kept: Kept) {
    const { auth, ...rest } = kept;
    const opened = auth.type === "none" ? null : this.open(name, kept);
    return {
      name,
      ...marked(kept.url, rest),
      auth: { type: auth.type, ...(auth.type === "headers" ? { headers: Object.keys(auth.sealed ?? {}) } : {}) },
      credential: opened === null ? null : !("headers" in opened) ? opened.unreadable : auth.oauth?.expired ? ("expired" as const) : ("sealed" as const),
      ...(auth.oauth ? { oauth: { ...(auth.oauth.expires_at ? { expires_at: auth.oauth.expires_at } : {}), scopes: auth.oauth.scopes, client: auth.oauth.client, ...(auth.oauth.client_id ? { client_id: auth.oauth.client_id } : {}) } } : {}),
    };
  }

  /** The sealed credential opened: its headers, and for OAuth the token set, whose access token is the header. */
  private open(name: string, kept: Kept): { headers: HeaderMap; set?: TokenSet } | { unreadable: "seal_key_missing" | "unreadable" } {
    if (!this.key) return { unreadable: "seal_key_missing" };
    if (kept.auth.check !== this.sealCheck || !isObject(kept.auth.sealed)) return { unreadable: "unreadable" };
    try {
      const headers = Object.fromEntries(Object.entries(kept.auth.sealed).map(([header, value]) => [header, unseal(this.key!, Buffer.from(value, "base64"), aad(name, header)).toString("utf8")]));
      if (kept.auth.type !== "oauth") return { headers };
      const set = JSON.parse(headers.oauth!) as TokenSet;
      return { headers: { authorization: `Bearer ${set.tokens.access_token}` }, set };
    } catch {
      return { unreadable: "unreadable" };
    }
  }

  /** The saved credential, opened, or the refusal that asks for it again. */
  private opened(name: string, kept: Kept, field: string): HeaderMap {
    if (kept.auth.type === "none") return {};
    if (kept.auth.oauth?.expired) throw invalid([{ field, reason: "expired", message: `The sign-in to ${name} expired or was revoked: ${SIGN_IN_AGAIN}.` }]);
    const opened = this.open(name, kept);
    if ("headers" in opened) return opened.headers;
    if (opened.unreadable === "seal_key_missing") throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so the saved credential of ${name} does not open. ${SEAL_KEY_HOW}`);
    throw invalid([{ field, reason: "missing", message: `The saved credential of ${name} does not open here (sealed under another seal key, or damaged): send it again.` }]);
  }

  /** A body's URL, auth and prices, or 422. */
  private admit(body: Record<string, unknown>, priced = false): { url: URL; auth: Auth; prices?: McpPrices } {
    const issues = unknownFields(body, priced ? ["url", "auth", "prices"] : ["url", "auth"]);
    const url = urlOf(body.url, issues);
    const auth = authOf(body.auth, issues);
    const prices = pricesOf(body.prices, issues);
    if (issues.length) throw invalid(issues);
    return { url: url!, auth: auth!, ...(prices ? { prices } : {}) };
  }

  /** The saved servers: none with no file, "unreadable" when the file does not read as this format. */
  private kept(): Record<string, Kept> | "unreadable" {
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return isObject(doc) && doc.format === FORMAT && isObject(doc.servers) ? (Object.assign(Object.create(null), doc.servers) as Record<string, Kept>) : "unreadable";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? Object.create(null) : "unreadable";
    }
  }

  /** The saved servers, or 409: a file that does not read is never written over, so no saved server is lost to it. */
  private servers(): Record<string, Kept> {
    const kept = this.kept();
    if (kept === "unreadable") throw new ApiError("store_unreadable", `${MCP_SERVERS_FILE} in the data directory does not read as ${FORMAT}: nothing is read from it or written to it until it is restored or removed.`);
    return kept;
  }

  private write(servers: Record<string, Kept>): void {
    if (this.stopped.signal.aborted) throw new ApiError("unavailable", "This server is stopping: nothing more is saved. Try again once it is back.", { retry_after_ms: 1000 }, { "retry-after": "1" });
    writeDurableSync(this.file, `${JSON.stringify({ format: FORMAT, servers }, null, 2)}\n`);
  }
}

/** `listed` with each known meta tool (mcp-meta.ts) marked `grantable: false` with its reason: the snapshot keeps what
 *  the server listed, and every read says which of its tools can't be granted. */
function marked<T extends { tools: McpTool[] }>(url: string, listed: T): T & { tools: (McpTool & { grantable?: false; reason?: string })[] } {
  return { ...listed, tools: listed.tools.map((tool) => {
    const meta = metaToolOf(url, tool.name);
    return meta ? { ...tool, grantable: false as const, reason: meta.reason } : tool;
  }) };
}

const aad = (name: string, header: string) => `mcp:${name}:${header}`;
/** `text` with every credential value cut out: each header's value, and a bearer's token alone, which a server may
 *  echo without its scheme. */
const scrub = (text: string, headers: HeaderMap): string =>
  Object.values(headers).flatMap((value) => [value, /^Bearer\s+(.+)$/i.exec(value)?.[1]]).filter((value): value is string => !!value).sort((a, b) => b.length - a.length).reduce((cut, value) => cut.split(value).join("[credential]"), text);
/** Which save of a server this is: a PUT or a sign-in makes a new one, a refresh of its token or tools does not. */
const saving = (kept: Kept) => `${kept.url} ${kept.updated_at}`;
/** How a server gets a seal key: what its launcher does (launcher/agentrun-serve). */
const SEAL_KEY_HOW = `Start it with its launcher, agentrun-serve, which keeps one in agentrun/seal.key under $XDG_CONFIG_HOME (~/.config by default), made at the first start, 0600 in a 0700 directory; or hand it ${SEAL_KEY_ENV} (32 random bytes in base64).`;
const notFound = (name: string) => new ApiError("not_found", `No MCP server ${name}: GET /v2/settings/mcp-servers lists them.`);
const credentialMissing = (type: AuthType, message: string): InputIssue => ({ field: type === "bearer" ? "auth.token" : type === "oauth" ? "auth.type" : "auth.headers", reason: "missing", message: type === "oauth" ? `${message} An OAuth server is signed in to first: POST /v2/settings/mcp-servers/{name}/oauth/start.` : message });
const nameOf = (name: string) => {
  if (!MCP_SERVER_NAME.test(name)) throw invalid([{ field: "name", reason: "invalid", message: "A server's name is 1 to 32 lowercase letters, digits and dashes, starting with a letter (no underscores, so mcp__<server>__<tool> splits one way)." }]);
  if (RESERVED_MCP_NAMES.includes(name)) throw invalid([{ field: "name", reason: "reserved", message: `'${name}' is reserved for AgentRun's own tools: a server under it would take their names and their permissions. Name the server another way.` }]);
};

/** JSON with sorted keys, so two listings of one tool compare equal whatever order the server sends its fields in. */
const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : isObject(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value) ?? "null";

/** The body's prices: each tool's USD a call, a finite number, 0 or more. Which tools the server lists is checked once
 *  it has listed them. */
function pricesOf(value: unknown, issues: InputIssue[]): McpPrices | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return void issues.push({ field: "prices", reason: "wrong_type", message: "prices is an object of the server's tool names to their price in USD a call." });
  const bad = Object.entries(value).filter(([, usd]) => typeof usd !== "number" || !Number.isFinite(usd) || usd < 0);
  for (const [tool] of bad) issues.push({ field: `prices.${tool}`, reason: "invalid", message: `prices.${tool} is a price in USD a call: a finite number, 0 or more.` });
  // Keyed by tool names, which may be an object's own properties (`__proto__`): no prototype to fall into.
  return bad.length ? undefined : (Object.assign(Object.create(null), value) as McpPrices);
}

function urlOf(value: unknown, issues: InputIssue[]): URL | undefined {
  if (typeof value !== "string" || value === "") return void issues.push({ field: "url", reason: value === undefined ? "missing" : "wrong_type", message: "url is the MCP server's Streamable HTTP endpoint, as text." });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return void issues.push({ field: "url", reason: "invalid", message: "url is not a URL." });
  }
  if (value.length > MAX_URL) issues.push({ field: "url", reason: "too_long", message: `url is at most ${MAX_URL} characters.` });
  else if (url.username || url.password) issues.push({ field: "url", reason: "invalid", message: "url holds a user or password: send a credential as auth instead." });
  else if (url.protocol === "http:" && !LOOPBACK(url.hostname)) issues.push({ field: "url", reason: "not_https", message: `url is http://${url.host}, which is not this machine's loopback: use https, or http only on loopback.` });
  else if (url.protocol !== "https:" && url.protocol !== "http:") issues.push({ field: "url", reason: "invalid", message: "url is https, or http on loopback." });
  url.hash = "";
  return url;
}

/** The body's auth: its type and, when it sends one, its credential as the headers it becomes. */
function authOf(value: unknown, issues: InputIssue[]): Auth | undefined {
  if (value === undefined) return { type: "none" };
  if (!isObject(value)) return void issues.push({ field: "auth", reason: "wrong_type", message: "auth is {type: none|bearer|headers|oauth, token?, headers?}." });
  const before = issues.length;
  issues.push(...unknownFields(value, ["type", "token", "headers"]).map((issue) => ({ ...issue, field: `auth.${issue.field}` })));
  const type = value.type;
  if (!(MCP_AUTH_TYPES as readonly unknown[]).includes(type)) return void issues.push({ field: "auth.type", reason: "not_an_option", message: `auth.type is one of ${MCP_AUTH_TYPES.join(", ")}.` });
  const check = (field: string, text: unknown) => {
    if (typeof text !== "string" || text === "") issues.push({ field, reason: "wrong_type", message: `${field} is text, not empty.` });
    else if (CONTROL.test(text)) issues.push({ field, reason: "invalid", message: `${field} holds a control character.` });
    else if (Buffer.byteLength(text) > MAX_VALUE_BYTES) issues.push({ field, reason: "too_long", message: `${field} is at most ${MAX_VALUE_BYTES} bytes.` });
  };
  let headers: HeaderMap | undefined;
  if ((type === "none" || type === "oauth") && (value.token !== undefined || value.headers !== undefined)) issues.push({ field: "auth", reason: "not_allowed", message: type === "none" ? "auth.type none sends no credential." : "auth.type oauth takes its credential from a sign-in, never from a body." });
  if (type === "bearer") {
    if (value.headers !== undefined) issues.push({ field: "auth.headers", reason: "not_allowed", message: "A bearer credential is auth.token." });
    if (value.token !== undefined) {
      check("auth.token", value.token);
      headers = { authorization: `Bearer ${String(value.token)}` };
    }
  }
  if (type === "headers") {
    if (value.token !== undefined) issues.push({ field: "auth.token", reason: "not_allowed", message: "Named headers are auth.headers." });
    if (value.headers !== undefined) {
      const entries = isObject(value.headers) ? Object.entries(value.headers) : [];
      if (!entries.length || entries.length > MAX_HEADERS) issues.push({ field: "auth.headers", reason: "invalid", message: `auth.headers names 1 to ${MAX_HEADERS} headers and their values.` });
      headers = Object.create(null) as HeaderMap;
      for (const [name, text] of entries) {
        const lower = name.toLowerCase();
        if (!HEADER_NAME.test(name) || RESERVED.has(lower)) issues.push({ field: `auth.headers.${name}`, reason: "invalid", message: `${name} is not a header a credential may be sent in.` });
        else if (lower in headers) issues.push({ field: `auth.headers.${name}`, reason: "duplicate", message: `${name} is named twice.` });
        check(`auth.headers.${name}`, text);
        headers[lower] = String(text);
      }
    }
  }
  return issues.length > before ? undefined : { type: type as AuthType, ...(headers ? { headers } : {}) };
}

/** What a response said about itself, for telling failures apart: the SDK's errors do not say whether a URL speaks MCP
 *  at all, or what a 401 asked for. */
type Seen = { status: number; headers: globalThis.Headers; rpc: Promise<boolean> };

/** Connect to `url`, agree a protocol revision, and list every tool (all pages), each request held to REQUEST_MS and
 *  MAX_RESPONSE_BYTES and the whole to PREVIEW_MS. A failure is an ApiError: 422 auth_required (with the auth the
 *  server asks for), 422 not_mcp, 422 input_invalid for a redirect, else 424 upstream_failed. */
async function listServer(url: URL, headers: HeaderMap, version: string, stop?: AbortSignal): Promise<Listed> {
  const sdk = await import("@modelcontextprotocol/client");
  const deadline = AbortSignal.any([AbortSignal.timeout(PREVIEW_MS), ...(stop ? [stop] : [])]);
  const seen: Seen[] = [];
  let overflow = false;
  const watched = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_MS), ...(init?.signal ? [init.signal] : [])]);
    const res = await fetch(input, { ...init, redirect: "manual", signal });
    const type = res.headers.get("content-type") ?? "";
    seen.push({ status: res.status, headers: res.headers, rpc: type.startsWith("text/event-stream") ? Promise.resolve(true) : type.includes("json") ? speaksJsonRpc(res.clone()) : Promise.resolve(false) });
    return capped(res, () => (overflow = true));
  };
  const transport = new sdk.StreamableHTTPClientTransport(url, { fetch: watched, requestInit: { headers, redirect: "manual" } });
  const client = new sdk.Client({ name: "agentrun-serve", version }, { versionNegotiation: { mode: "auto" } });
  try {
    await client.connect(transport, { timeout: REQUEST_MS, signal: deadline });
    // Paged here rather than by listTools(), which reads every page before answering: a snapshot past its caps
    // stops at the page that crosses them.
    const tools: McpTool[] = [];
    let bytes = 0;
    if (client.getServerCapabilities()?.tools) {
      for (let cursor: string | undefined, pages = 0; ; ) {
        const page = await client.request({ method: "tools/list", ...(cursor !== undefined ? { params: { cursor } } : {}) }, { timeout: PREVIEW_MS, signal: deadline });
        for (const tool of page.tools) {
          const kept: McpTool = {
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            input_schema: tool.inputSchema,
            ...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          };
          tools.push(kept);
          bytes += Buffer.byteLength(JSON.stringify(kept));
          if (tools.length > MAX_TOOLS) throw invalid([{ field: "url", reason: "too_many_tools", message: `This server lists more than ${MAX_TOOLS} tools (${tools.length} so far, listing stopped): a server is kept with at most ${MAX_TOOLS}.` }]);
          if (bytes > MAX_SNAPSHOT_BYTES) throw invalid([{ field: "url", reason: "tools_too_large", message: `This server's tools come to more than ${MAX_SNAPSHOT_BYTES / 2 ** 20} MiB of names, descriptions and schemas (${tools.length} tools so far, listing stopped): a server is kept with at most ${MAX_SNAPSHOT_BYTES / 2 ** 20} MiB.` }]);
        }
        if (page.nextCursor === undefined || page.nextCursor === cursor) break;
        if (++pages >= MAX_PAGES) throw new ApiError("upstream_failed", `The MCP server's tool list did not end within ${MAX_PAGES} pages.`);
        cursor = page.nextCursor;
      }
    }
    const instructions = client.getInstructions();
    return {
      protocol: client.getNegotiatedProtocolVersion() ?? "unknown",
      server_info: client.getServerVersion() ?? null,
      ...(instructions ? { instructions } : {}),
      tools,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw await refusal(error, seen, overflow, url, headers, deadline, sdk);
  } finally {
    await client.close().catch(() => {});
  }
}

async function refusal(error: unknown, seen: Seen[], overflow: boolean, url: URL, headers: HeaderMap, deadline: AbortSignal, sdk: typeof import("@modelcontextprotocol/client")): Promise<ApiError> {
  const upstream = (message: string, status?: number) => new ApiError("upstream_failed", message, status ? { details: { status } } : {});
  if (overflow) return upstream(`The MCP server answered more than ${MAX_RESPONSE_BYTES / 2 ** 20} MiB in one response.`);
  const redirect = seen.find((one) => one.status >= 300 && one.status < 400);
  if (redirect) {
    const to = redirect.headers.get("location");
    let where = to?.slice(0, 200);
    try {
      if (to) where = new URL(to, url).href;
    } catch {}
    return invalid([{ field: "url", reason: "redirect", message: scrub(`The MCP server answered ${redirect.status}${where ? `, pointing to ${where}` : ""}. Redirects are not followed, so a credential goes only where you send it: use the address it points to.`, headers) }]);
  }
  const denied = seen.find((one) => one.status === 401 || one.status === 403);
  if (denied) {
    const auth = await authAsked(url, denied.headers, deadline, sdk);
    const sent = Object.keys(headers).length > 0;
    const asks = auth === "oauth" ? `It signs in with OAuth: ${sent ? `${SIGN_IN_AGAIN}, or ` : ""}sign in with POST /v2/settings/mcp-servers/{name}/oauth/start and its url.` : "Send a bearer token or the headers it takes.";
    return new ApiError("auth_required", `The MCP server ${sent ? "refused the credential sent" : "asks for a credential"} (HTTP ${denied.status}). ${asks}`, { details: { auth, status: denied.status } });
  }
  const failed = seen.find((one) => one.status >= 500);
  if (failed) return upstream(`The MCP server answered HTTP ${failed.status}.`, failed.status);
  if (!seen.length) {
    if (deadline.aborted || timedOut(error)) return upstream(`The MCP server did not answer within ${REQUEST_MS / 1000} s.`);
    return upstream(`Could not reach the MCP server at ${url.origin}${causeCode(error) ? ` (${causeCode(error)})` : ""}.`);
  }
  if (!(await Promise.all(seen.map((one) => one.rpc))).some(Boolean)) return new ApiError("not_mcp", `${url.href} does not speak MCP over Streamable HTTP: it answered HTTP ${seen.at(-1)!.status} with no JSON-RPC reply.`);
  // The listing's own limit when it was the one that ran out, else one request's.
  if (deadline.aborted || timedOut(error)) return upstream(deadline.aborted ? `The MCP server did not finish listing its tools within ${PREVIEW_MS / 1000} s.` : `The MCP server did not answer a request within ${REQUEST_MS / 1000} s.`);
  // Cut every credential value from the SDK's words: a server may echo what it was sent.
  const said = scrub(error instanceof Error ? error.message : String(error), headers);
  return upstream(`The MCP server failed to list its tools: ${said.slice(0, 300)}`);
}

/** What a 401 or 403 asks for: `oauth` when the server names protected-resource metadata (its WWW-Authenticate, or a
 *  well-known document naming an authorization server), else `bearer`. The probe sends no credential. */
async function authAsked(url: URL, headers: globalThis.Headers, deadline: AbortSignal, sdk: typeof import("@modelcontextprotocol/client")): Promise<"oauth" | "bearer"> {
  if (sdk.extractWWWAuthenticateParams(new Response(null, { headers })).resourceMetadataUrl) return "oauth";
  try {
    const probe = async (input: string | URL | Request, init?: RequestInit) => capped(await fetch(input, { ...init, redirect: "manual", signal: AbortSignal.any([deadline, AbortSignal.timeout(5_000)]) }), () => {});
    const metadata = await sdk.discoverOAuthProtectedResourceMetadata(url, undefined, probe);
    return metadata.authorization_servers?.length ? "oauth" : "bearer";
  } catch {
    return "bearer";
  }
}

/** Whether a JSON body is a JSON-RPC message, read no further than its first 64 KiB. */
async function speaksJsonRpc(res: Response): Promise<boolean> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return false;
    let text = "";
    for (let chunk = await reader.read(); !chunk.done && text.length < 65_536; chunk = await reader.read()) text += Buffer.from(chunk.value).toString("utf8");
    await reader.cancel().catch(() => {});
    return /"jsonrpc"\s*:\s*"2\.0"/.test(text);
  } catch {
    return false;
  }
}

/** `res` with its body cut off at MAX_RESPONSE_BYTES, `over` told when it is. */
function capped(res: Response, over: () => void): Response {
  if (!res.body || [101, 204, 205, 304].includes(res.status)) return res;
  let bytes = 0;
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        over();
        out.error(new Error(`response over ${MAX_RESPONSE_BYTES} bytes`));
      } else out.enqueue(chunk);
    },
  }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

const timedOut = (error: unknown): boolean => {
  for (let at = error; at instanceof Error; at = at.cause) if (at.name === "TimeoutError" || at.name === "AbortError" || /timed? ?out/i.test(at.message)) return true;
  return false;
};
const causeCode = (error: unknown): string | undefined => {
  for (let at = error; isObject(at); at = (at as { cause?: unknown }).cause) if (typeof at.code === "string" && /^E[A-Z]+$/.test(at.code)) return at.code;
  return undefined;
};
