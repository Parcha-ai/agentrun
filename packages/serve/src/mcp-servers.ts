// Remote MCP servers a person adds through /v2/settings/mcp-servers. A preview connects with the official SDK client
// (@modelcontextprotocol/client: 2026-07-28 first, 2025-era servers by its fallback), lists every tool and stores
// nothing. A save previews, then keeps the URL, the tool snapshot the person saw and the credential in
// DIR/mcp-servers.json (0600, written whole, synced, renamed), each header value sealed (AES-256-GCM, tool-keys.ts' seal
// key) and bound to `mcp:<server>:<header>`, so a value moved to another server or header does not open. An OAuth
// server's token set (mcp-oauth.ts) is sealed the same way, bound to `mcp:<server>:oauth`, and refreshed here. No read
// returns a credential. No redirect is followed: a credential goes only to the URL the person gave.
import { GITHUB_MCP_ONLY, GITHUB_MCP_ORIGIN, githubMcpUrl } from "./github.js";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError, invalid } from "./errors.js";
import { writeDurableSync } from "./server-fs.js";
// The probe and request validation are the one copy in mcp-probe.ts, shared with the store-backed registry
// (mcp-servers-store.ts) so both answer and refuse byte-identically; only the storage and sealing differ, below.
import {
  type Auth, type AuthType, authOf, canonical, credentialMissing, type HeaderMap, type Listed, listServer, marked,
  MAX_OAUTH_VALUE_BYTES, MCP_AUTH_TYPES, MCP_SERVER_NAME, type McpPrices, type McpTool, nameOf, notFound, oauthValueValid,
  pricesListed, pricesOf, REFRESH_MARGIN_MS, RESERVED_MCP_NAMES, scopesValid, SEAL_KEY_HOW, UNKNOWN_EXPIRY_MS, UNUSABLE, urlOf,
} from "./mcp-probe.js";
import { type ClientKind, MCP_SETTINGS_PAGE, McpSignIns, type OAuthNetwork, systemNetwork, reasonOf, refreshed, refused, SIGN_IN_AGAIN, type TokenSet } from "./mcp-oauth.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { serverGate, type ToolSettingsMap } from "./tool-plane.js";
import { isObject, unknownFields } from "./validate.js";

// The names other modules still import from here (server.ts, openapi.ts, templates.ts, the runner's claim) now live in
// mcp-probe.ts; re-exported so those importers are unchanged until the cut repoints them.
export { MCP_AUTH_TYPES, MCP_SERVER_NAME, REFRESH_MARGIN_MS, RESERVED_MCP_NAMES, UNKNOWN_EXPIRY_MS, UNUSABLE };
export type { McpPrices, McpTool };

export const MCP_SERVERS_FILE = "mcp-servers.json";
const FORMAT = "mcp-servers/1";
/** How long a stop waits for the refreshes and code exchanges it aborted. */
const CLOSE_MS = 2_000;

/** An OAuth sign-in, what may be shown of it: never a token. */
type OAuthNote = { expires_at?: string; scopes: string[]; client: ClientKind; client_id?: string; expired?: true };
type Kept = Listed & { url: string; auth: { type: AuthType; sealed?: Record<string, string>; check?: string; oauth?: OAuthNote }; prices?: McpPrices; listed_at: string; updated_at: string };

export class McpServers {
  readonly file: string;
  /** The connected GitHub App's installation token for listing a `github_app` server's tools as it is saved, refreshed
   *  or previewed by name (github-connection.ts tokenForListing); a run's own is minted at its launch (runs.ts). Set by
   *  the server; absent, such a server cannot be saved. */
  appToken?: (signal?: AbortSignal) => Promise<{ token: string } | { unusable: string }>;
  /** The one origin a github_app server may have (GITHUB_MCP_ORIGIN; a test's fake through the server's seam): the App's
   *  tokens are minted for, and sent to, nothing else. */
  appOrigin = GITHUB_MCP_ORIGIN;
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

  /** This server's address as a browser reaches it (`base`: an OAuth sign-in's callback is under it), and where it
   *  listens (`listening`, required: the same as `base` when no public address is set). A loopback authorization
   *  server never reaches either one's port when it is local (McpSignIns.own). */
  attach(base: string, listening: string): void {
    this.signIns.base = base.replace(/\/+$/, "");
    this.signIns.listening = listening.replace(/\/+$/, "");
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
      return marked(kept.url, await listServer(new URL(kept.url), await this.withAppToken(kept, new URL(kept.url), this.opened(name, kept, "name"), stop), this.version, stop));
    }
    const { url, auth } = this.admit(body);
    // A github_app server's credential is a token of the App, minted here, as for a saved one: its static headers are optional.
    if (auth.type !== "none" && auth.type !== "github_app" && !auth.headers) throw invalid([credentialMissing(auth.type, "A preview needs the credential it is to connect with.")]);
    return marked(url.href, await listServer(url, await this.withAppToken({ auth: { type: auth.type } }, url, auth.headers ?? {}, stop), this.version, stop));
  }

  /** PUT: preview, then keep the server with the tools listed. A body with no credential keeps the sealed one, while
   *  the auth type and the URL's origin stay the same. */
  async save(name: string, body: Record<string, unknown>, stop?: AbortSignal) {
    nameOf(name);
    const { url, auth, prices } = this.admit(body, true);
    if (auth.type !== "none" && !this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no MCP server credential: it never keeps one in the clear. ${SEAL_KEY_HOW}`);
    const was = this.servers()[name];
    let headers = auth.headers;
    // A github_app server's own headers are only its static ones (its token is minted), kept as saved only at the same
    // origin, as any saved credential: a move takes them again, or none goes to another origin.
    if (auth.type === "github_app" && !headers && was?.auth.type === "github_app" && was.auth.sealed) {
      if (new URL(was.url).origin !== url.origin) throw invalid([credentialMissing(auth.type, `The address moved from ${new URL(was.url).origin} to ${url.origin}: send the headers again, so saved ones never go to another origin.`)]);
      headers = this.opened(name, was, "auth.headers");
    }
    if (auth.type !== "none" && auth.type !== "github_app" && !headers) {
      if (!was || was.auth.type !== auth.type) throw invalid([credentialMissing(auth.type, `The server ${name} has no saved ${auth.type} credential to keep.`)]);
      if (new URL(was.url).origin !== url.origin) throw invalid([credentialMissing(auth.type, `The address moved from ${new URL(was.url).origin} to ${url.origin}: send the credential again, so a saved one never goes to another origin.`)]);
      await this.freshen(name);
      // Read again after the refresh's wait: a sign-in to another URL that landed meanwhile is never sent here.
      const now = this.need(name);
      if (saving(now) !== saving(was)) throw new ApiError("unavailable", `The server ${name} was signed in to, saved or forgotten meanwhile: save it again.`);
      headers = this.opened(name, now, credentialMissing(auth.type, "").field);
    }
    const listed = await listServer(url, await this.withAppToken({ auth: { type: auth.type } }, url, headers ?? {}, stop), this.version, stop);
    // A price names a tool the server listed now, or nothing is saved.
    const unlisted = Object.keys(prices ?? {}).filter((tool) => !listed.tools.some((listedTool) => listedTool.name === tool));
    if (unlisted.length) throw invalid(unlisted.map((tool) => ({ field: `prices.${tool}`, reason: "not_an_option", message: `The server ${name} lists no tool ${tool}; its tools are ${listed.tools.map((t) => t.name).join(", ") || "none"}.` })));
    const now = new Date().toISOString();
    const sealed = auth.type !== "oauth" && headers && Object.keys(headers).length > 0 && Object.fromEntries(Object.entries(headers).map(([header, value]) => [header, seal(this.key!, Buffer.from(value, "utf8"), aad(name, header)).toString("base64")]));
    const servers = this.servers();
    // An OAuth server keeps its token set as sealed (a refresh meanwhile kept); only a sign-in replaces it, and one that
    // lands, or a PUT or DELETE, while this listed makes the listing stale: its token never goes with another URL.
    if (auth.type === "oauth" && (!servers[name] || saving(servers[name]) !== saving(was!))) throw new ApiError("unavailable", `The server ${name} was signed in to, saved or forgotten while its tools were listed: save it again.`);
    const kept = auth.type === "oauth" ? servers[name]!.auth : { type: auth.type, ...(sealed ? { sealed, check: this.sealCheck } : {}) };
    // A body with no `prices` keeps the saved ones, for the tools still listed at the same address: a save from any
    // client never turns a paid tool into an unmetered one. `{}` clears them, and a new address is another server.
    const before = servers[name];
    const priced = prices ?? (before?.url === url.href ? pricesListed(before.prices, listed.tools) : undefined);
    servers[name] = { url: url.href, auth: kept, ...listed, ...(priced && Object.keys(priced).length ? { prices: priced } : {}), listed_at: now, updated_at: now };
    this.write(servers);
    return this.view(name, servers[name]);
  }

  /** POST refresh: list the saved server's tools again, keep them, and say what was added, removed and changed. */
  async refresh(name: string, stop?: AbortSignal) {
    await this.freshen(name);
    const was = this.need(name);
    const listed = await listServer(new URL(was.url), await this.withAppToken(was, new URL(was.url), this.opened(name, was, "name"), stop), this.version, stop);
    const servers = this.servers();
    const now = servers[name];
    if (!now) throw notFound(name);
    // A PUT while listing (another URL, another account's credential) makes this listing stale: never kept.
    if (canonical([now.url, now.auth, now.updated_at]) !== canonical([was.url, was.auth, was.updated_at])) throw new ApiError("unavailable", `The server ${name} was changed while its tools were listed: refresh it again.`);
    const before = new Map(now.tools.map((tool) => [tool.name, canonical(tool)]));
    const after = new Map(listed.tools.map((tool) => [tool.name, canonical(tool)]));
    const next: Kept = { ...now, ...listed, listed_at: new Date().toISOString() };
    // A price of a tool the server no longer lists goes with it.
    const prices = pricesListed(now.prices, listed.tools);
    if (Object.keys(prices).length) next.prices = prices;
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
    if (scopes !== undefined && !scopesValid(scopes)) issues.push({ field: "scopes", reason: "invalid", message: "scopes is a list of 1 to 32 OAuth scopes." });
    for (const [field, text] of [["client_id", client_id], ["client_secret", client_secret]] as const)
      if (text !== undefined && !oauthValueValid(text)) issues.push({ field, reason: "invalid", message: `${field} is text, at most ${MAX_OAUTH_VALUE_BYTES} bytes.` });
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
    // Opened first: a credential that does not open says so, whatever else is true of it (an expired token on a server
    // without its seal key is a seal problem, which no retry fixes).
    const opened = this.open(name, kept);
    if (!("headers" in opened)) return { unopened: opened.unreadable === "seal_key_missing" ? UNUSABLE.noSealKey : UNUSABLE.damaged };
    if (kept.auth.oauth?.expired) return { unopened: UNUSABLE.signedOut };
    // An access token past its expiry whose refresh got no answer (freshen kept the refresh token for the next launch):
    // never handed over, so the server's 401 never reads as a sign-in to make again.
    const until = kept.auth.type === "oauth" && kept.auth.oauth?.expires_at ? Date.parse(kept.auth.oauth.expires_at) : NaN;
    if (until <= Date.now()) return { unopened: UNUSABLE.silent };
    // Tagged, never told apart by a key a saved header could also have (`unopened` is a header name like any other).
    return { headers: opened.headers };
  }

  /** An OAuth server's token set refreshed when its access token expires within `margin`. Tried twice when its
   *  authorization server does not answer, which writes nothing. A refusal (revoked, expired)
   *  marks the sign-in expired; an authorization server out of reach leaves it as it is. It runs on exactly these
   *  paths: before a run's process is spawned (runs.ts mcpFresh: a start, a reopen, a relaunch after a crash, a
   *  message that brings the process up, an approval's answer that does), and before a preview by name, a PUT that keeps the token set, and a POST
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
      // Tried twice when the authorization server does not answer (a timeout, a 5xx, the network): only a refusal is final.
      for (let tries = 0; set.tokens.refresh_token && !next && !no && tries < 2 && !this.stopped.signal.aborted; tries++) {
        try {
          next = await refreshed(set, kept.url, this.stopped.signal, this.network, { own: this.signIns.own });
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

  /** The server's own tool settings (GET /settings/tools), set as the server starts: each tool's permission on a read
   *  is the one they put in force (serverGate), as capabilities and an agent's read give it. */
  toolSettings: () => ToolSettingsMap = () => ({});

  private view(name: string, kept: Kept) {
    const { auth, ...rest } = kept;
    const settings = this.toolSettings();
    const listed = marked(kept.url, rest);
    const opened = auth.type === "none" ? null : this.open(name, kept);
    // The tools a call of which no price meters: outside the run's cost and its cap, said on every read.
    const unmetered = kept.tools.filter((tool) => !(kept.prices && Object.hasOwn(kept.prices, tool.name))).map((tool) => tool.name);
    return {
      name,
      ...listed,
      // Each tool's permission as this server applies it to an agent that sets none: the console shows a tool's row by
      // it as soon as the tool is ticked, before any agent's read gives it.
      tools: listed.tools.map((tool) => ({ ...tool, ...serverGate(`mcp:${name}/${tool.name}`, settings) })),
      ...(unmetered.length ? { not_metered: unmetered } : {}),
      auth: { type: auth.type, ...(auth.type === "headers" || auth.type === "github_app" ? { headers: Object.keys(auth.sealed ?? {}) } : {}) },
      credential: opened === null ? null : !("headers" in opened) ? opened.unreadable : auth.oauth?.expired ? ("expired" as const) : ("sealed" as const),
      ...(auth.oauth ? { oauth: { ...(auth.oauth.expires_at ? { expires_at: auth.oauth.expires_at } : {}), scopes: auth.oauth.scopes, client: auth.oauth.client, ...(auth.oauth.client_id ? { client_id: auth.oauth.client_id } : {}) } } : {}),
    };
  }

  /** The sealed credential opened: its headers, and for OAuth the token set, whose access token is the header. */
  private open(name: string, kept: Kept): { headers: HeaderMap; set?: TokenSet } | { unreadable: "seal_key_missing" | "unreadable" } {
    // A github_app server with no static headers keeps nothing sealed: its token is minted for each use.
    if (kept.auth.type === "github_app" && !kept.auth.sealed) return { headers: {} };
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

  /** `headers` and, for a github_app server, an installation token of the connected App to list its tools with. */
  private async withAppToken(kept: { auth: { type: AuthType } }, url: URL, headers: HeaderMap, stop?: AbortSignal): Promise<HeaderMap> {
    if (kept.auth.type !== "github_app") return headers;
    // Never a token of the App to another origin: a row saved before this rule is refused here too.
    if (!githubMcpUrl(url, this.appOrigin)) throw invalid([{ field: "url", reason: "not_allowed", message: GITHUB_MCP_ONLY }]);
    const minted = this.appToken ? await this.appToken(stop) : { unusable: "This server has no GitHub App: Connect GitHub in Settings." };
    if ("unusable" in minted) throw new ApiError("github_not_connected", minted.unusable);
    return { ...headers, authorization: `Bearer ${minted.token}` };
  }

  /** Whether the saved server `name` takes the connected GitHub App's tokens, minted for each run's launch. */
  takesAppToken(name: string): boolean {
    const saved = this.saved(name);
    return saved?.auth.type === "github_app" && githubMcpUrl(saved.url, this.appOrigin);
  }

  /** A body's URL, auth and prices, or 422. */
  private admit(body: Record<string, unknown>, priced = false): { url: URL; auth: Auth; prices?: McpPrices } {
    const issues = unknownFields(body, priced ? ["url", "auth", "prices"] : ["url", "auth"]);
    const url = urlOf(body.url, issues);
    const auth = authOf(body.auth, issues);
    const prices = pricesOf(body.prices, issues);
    // The App's tokens go to GitHub alone: a github_app server is GitHub's hosted MCP, nothing else.
    // A github_app server's URL is refused in the GitHub rule's words, in place of any other the URL drew.
    if (url && auth?.type === "github_app" && !githubMcpUrl(url, this.appOrigin)) issues.splice(0, issues.length, ...issues.filter((issue) => issue.field !== "url"), { field: "url", reason: "not_allowed", message: GITHUB_MCP_ONLY });
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

/** The file store's own seal AAD: each header value is sealed bound to its server and header name. */
const aad = (name: string, header: string) => `mcp:${name}:${header}`;
/** Which save of a server this is: a PUT or a sign-in makes a new one, a refresh of its token or tools does not. */
const saving = (kept: Kept) => `${kept.url} ${kept.updated_at}`;
