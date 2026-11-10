// The owner's remote MCP servers over the one store (store.mcp, store.mcpOauth), the store-backed replacement for the
// McpServers file class (mcp-servers.ts). The probe and request validation are shared verbatim (mcp-probe.ts), so every
// answer and refusal reads the same; what differs is only where the registry and the sign-ins in flight live and how the
// credential is sealed. The credential is one sealed blob per row (store/seal.ts §7, the url's origin bound inside), so a
// read opens it to show the auth's header names, the OAuth note and whether the sign-in expired; with no seal key a read
// shows less than the file did (a degenerate misconfiguration — no credential can be saved without the key anyway).
//
// Per the run-time ruling, the runner reads MCP servers, pins and credentials from the store at a run's claim
// (runner/mcp-claim.ts), including the OAuth token refresh. So this server-side registry has NO headers()/headersForRun()
// and does NO token refresh: it is the owner's create/preview/save/refresh(tools)/remove and the OAuth sign-in, and nothing
// a run's launch calls. The switch wires it where `new McpServers(...)` was; mcpSource is dropped.
import { ApiError, invalid, type InputIssue } from "./errors.js";
import { metaToolOf } from "./mcp-meta.js";
import {
  type Auth, authOf, canonical, credentialMissing, type HeaderMap, type Listed, listServer, marked, MAX_OAUTH_VALUE_BYTES, type McpPrices,
  type McpTool, nameOf, notFound, oauthValueValid, pricesListed, pricesOf, scopesValid, urlOf,
} from "./mcp-probe.js";
import { listMcpServers, openServerCredential, putPendingSignIn, removeMcpServer, saveMcpServer, takePendingSignIn } from "./mcp-store.js";
import { checkPrivateHosts, privateOAuthHosts, savePrivateOAuthHosts } from "./mcp-private-hosts.js";
// MCP's secret writes, registered with the one gate as the registry loads (the server's dispatch reads them).
import "./mcp-secret-writes.js";
import { type SecretMeta, secretMeta, secretName } from "./secret-writes.js";
import { type ClientKind, issuerOf, MAX_PENDING, MCP_SETTINGS_PAGE, McpSignIns, type OAuthNetwork, type Pending, type PendingStore, reasonOf, SIGN_IN_AGAIN, systemNetwork, type TokenSet } from "./mcp-oauth.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { GITHUB_MCP_ONLY, GITHUB_MCP_ORIGIN, githubMcpUrl } from "./github.js";
import { serverGate, type ToolSettingsMap } from "./tool-plane.js";
import { type McpCredential, type Mcp, type McpOauth, type McpServerRow, type Settings, type Store } from "./store/index.js";
import { isObject, unknownFields } from "./validate.js";

const SCOPE_LIST = "scopes is a list of 1 to 32 OAuth scopes.";
const MAX_VALUE_BYTES = MAX_OAUTH_VALUE_BYTES;

/** The store slice this layer reads and writes; `settings` for the private-network OAuth hosts the owner allows. */
type McpServersStore = { readonly mcp: Mcp; readonly mcpOauth: McpOauth; readonly settings: Pick<Settings, "get" | "put">; flush: Store["flush"] };

/** The sign-ins in flight over the store (store.mcpOauth): the sign-in's secret parts (the PKCE verifier and the OAuth
 *  client, with its secret) sealed together by its state, the rest of its working state plain JSON the callback rebuilds.
 *  `set` sweeps what has expired and refuses past MAX_PENDING live rows before it writes (what the PendingStore contract
 *  promises), and a start with no verifier is a bug, not a row. `take` deletes and returns in one atomic statement
 *  (store.mcpOauth.take), so a replay or an expired state takes nothing. */
function pendingOverStore(store: McpServersStore, sealKey: Buffer): PendingStore {
  return {
    async set(state, entry) {
      if (!entry.verifier) throw new ApiError("internal", "A sign-in cannot be saved with no PKCE verifier.");
      const now = Date.now();
      await store.mcpOauth.sweepExpired(now);
      if ((await store.mcpOauth.count(now)) >= MAX_PENDING) throw new ApiError("rate_limited", `There are already ${MAX_PENDING} MCP sign-ins in flight; finish or wait one out, then start the sign-in again.`);
      await putPendingSignIn(store, sealKey, {
        state,
        server: entry.name,
        verifier: entry.verifier,
        ...(entry.client ? { client: entry.client } : {}),
        working: { url: entry.url, was: entry.was, ...(entry.scope ? { scope: entry.scope } : {}), kind: entry.kind, ...(entry.discovery ? { discovery: entry.discovery } : {}), ...(entry.resource ? { resource: entry.resource } : {}) },
        expiresAt: entry.expires,
      });
    },
    async take(state) {
      const row = await takePendingSignIn(store, sealKey, state, Date.now());
      if (!row) return undefined;
      const w = (row.working ?? {}) as { url: string; was: string | null; scope?: string; kind: ClientKind; discovery?: unknown; resource?: string };
      return {
        name: row.server, url: w.url, was: w.was ?? null, ...(w.scope ? { scope: w.scope } : {}), kind: w.kind,
        ...(row.client ? { client: row.client as Pending["client"] } : {}), verifier: row.verifier,
        ...(w.discovery ? { discovery: w.discovery as Pending["discovery"] } : {}), ...(w.resource ? { resource: w.resource } : {}),
        expires: row.expiresAt,
      };
    },
  };
}

/** The saved credential opened for a run of this server's own reads (preview by name, refresh, save keeping it): its
 *  headers to send, or the refusal that asks for it again, in the file registry's words. */
type Opened = { headers: HeaderMap; credential: McpCredential & { origin: string } };

export class McpServersOverStore {
  /** The connected GitHub App's installation token for listing a `github_app` server's tools as it is previewed, saved
   *  or refreshed (github-connection.ts tokenForListing); a run's own is minted at its claim (runner/mcp-claim.ts). Set by
   *  the server; absent, such a server's tools can't be listed (github_not_connected). */
  appToken?: (signal?: AbortSignal) => Promise<{ token: string } | { unusable: string } | { failed: string }>;
  /** The one origin a github_app server may have (GITHUB_MCP_ORIGIN; a test's fake through the server's seam): the App's
   *  tokens are minted for, and sent to, nothing else. */
  appOrigin = GITHUB_MCP_ORIGIN;
  private readonly sealKey: Buffer;
  private readonly signIns: McpSignIns;
  /** The callbacks under way, which close() waits out before the server lets its data go. */
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly stopped = new AbortController();

  constructor(private readonly store: McpServersStore, env: NodeJS.ProcessEnv, private readonly version: string, network: OAuthNetwork = systemNetwork) {
    // The server never starts without a seal key (seal-key.ts ensureSealKey), so there is no keyless registry: every
    // credential is kept sealed under it.
    const sealKey = sealKeyOf(env[SEAL_KEY_ENV]);
    if (!sealKey) throw new Error(`MCP servers' credentials are kept under the server's seal key (${SEAL_KEY_ENV}), and none was handed over: the server does not start without one.`);
    this.sealKey = sealKey;
    this.signIns = new McpSignIns(network, pendingOverStore(store, sealKey), () => privateOAuthHosts(store));
  }

  /** This server's address as a browser reaches it and where it listens (McpServers.attach). */
  attach(base: string, listening: string): void {
    this.signIns.base = base.replace(/\/+$/, "");
    this.signIns.listening = listening.replace(/\/+$/, "");
  }

  clientDocument() {
    return this.signIns.clientDocument();
  }

  /** The origin the authorization server sends the browser back to. */
  get callbackOrigin(): string {
    return new URL(this.signIns.base).origin;
  }

  /** The server's own tool settings, set as the server starts (McpServers.toolSettings). */
  toolSettings: () => ToolSettingsMap = () => ({});

  async close(boundMs = 2_000): Promise<void> {
    this.stopped.abort();
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((done) => setTimeout(done, boundMs).unref())]);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    void work.then(() => this.inflight.delete(work), () => this.inflight.delete(work));
    return work;
  }

  /** GET .../oauth/private-hosts: the private-network hosts an authorization server may be on (none by default). */
  async privateHosts(): Promise<{ hosts: string[] }> {
    return { hosts: await privateOAuthHosts(this.store) };
  }

  /** PUT .../oauth/private-hosts: the list replaced in store.settings, durable before it answers; or 422 in words. */
  async setPrivateHosts(body: Record<string, unknown>): Promise<{ hosts: string[] }> {
    const hosts = checkPrivateHosts(body);
    await savePrivateOAuthHosts(this.store, hosts);
    await this.store.flush();
    return { hosts };
  }

  async list() {
    const rows = await listMcpServers(this.store);
    return { servers: await Promise.all(rows.slice().sort((a, b) => a.name.localeCompare(b.name)).map((row) => this.view(row))) };
  }

  async get(name: string) {
    return this.view(await this.need(name));
  }

  /** POST preview: `{url, auth}`, or `{name}` for a saved server with its sealed credential. Stores nothing. */
  async preview(body: Record<string, unknown>, stop?: AbortSignal): Promise<Listed> {
    if (body.name !== undefined && body.url === undefined) {
      const issues = unknownFields(body, ["name"]);
      if (issues.length) throw invalid(issues);
      const name = String(body.name);
      const kept = await this.need(name);
      const url = new URL(kept.url);
      return marked(kept.url, await this.listServer(url, await this.withAppToken(kept.auth, url, (await this.opened(name, kept, "name")).headers, stop), stop));
    }
    const { url, auth } = this.admit(body);
    // A github_app server's credential is a token of the App, minted here, as for a saved one: its static headers are optional.
    if (auth.type !== "none" && auth.type !== "github_app" && !auth.headers) throw invalid([credentialMissing(auth.type, "A preview needs the credential it is to connect with.")]);
    return marked(url.href, await this.listServer(url, await this.withAppToken(auth.type, url, auth.headers ?? {}, stop), stop));
  }

  /** PUT: preview, then keep the server with the tools listed. A body with no credential keeps the sealed one, while the
   *  auth type and the URL's origin stay the same. */
  async save(name: string, body: Record<string, unknown>, stop?: AbortSignal) {
    nameOf(name);
    const { url, auth, prices } = this.admit(body, true);
    const was = await this.store.mcp.server(name);
    let credential: McpCredential | undefined;
    // The sealed credential kept (no new one sent) keeps its own time (credential_changed_at); a new one moves it.
    let kept: number | null | undefined;
    let headers = auth.headers;
    if (auth.type === "github_app") {
      // Its own headers are only its static ones (its token is minted): new ones are kept; none sent keeps the saved ones,
      // at the same origin only, as any saved credential.
      if (headers) credential = { type: "headers", headers };
      else if (was?.auth === "github_app" && was.sealed !== null) {
        if (new URL(was.url).origin !== url.origin) throw invalid([credentialMissing(auth.type, `The address moved from ${new URL(was.url).origin} to ${url.origin}: send the headers again, so saved ones never go to another origin.`)]);
        const open = await this.opened(name, was, "auth.headers");
        credential = open.credential;
        headers = open.headers;
        kept = was.credentialChangedAt;
      }
    } else if (auth.type !== "none" && !headers) {
      if (!was || was.auth !== auth.type) throw invalid([credentialMissing(auth.type, `The server ${name} has no saved ${auth.type} credential to keep.`)]);
      if (new URL(was.url).origin !== url.origin) throw invalid([credentialMissing(auth.type, `The address moved from ${new URL(was.url).origin} to ${url.origin}: send the credential again, so a saved one never goes to another origin.`)]);
      const open = await this.opened(name, was, credentialMissing(auth.type, "").field);
      credential = open.credential;
      headers = open.headers;
      kept = was.credentialChangedAt;
    } else if (auth.type !== "none") {
      credential = { type: "headers", headers: headers! };
    }
    const listed = await this.listServer(url, await this.withAppToken(auth.type, url, headers ?? {}, stop), stop);
    const unlisted = Object.keys(prices ?? {}).filter((tool) => !listed.tools.some((listedTool) => listedTool.name === tool));
    if (unlisted.length) throw invalid(unlisted.map((tool) => ({ field: `prices.${tool}`, reason: "not_an_option", message: `The server ${name} lists no tool ${tool}; its tools are ${listed.tools.map((t) => t.name).join(", ") || "none"}.` })));
    // A body with no `prices` keeps the saved ones, for the tools still listed at the same address.
    const priced = prices ?? (was?.url === url.href ? pricesListed((was.prices ?? undefined) as McpPrices | undefined, listed.tools) : undefined);
    const saved = await saveMcpServer(this.store, this.sealKey, {
      name, url: url.href, auth: auth.type, protocol: listed.protocol, tools: listed.tools, serverInfo: listed.server_info, instructions: listed.instructions ?? null,
      ...(priced && Object.keys(priced).length ? { prices: priced } : {}), ...(credential ? { credential } : {}), ...(kept !== undefined ? { credentialChangedAt: kept } : {}),
    }, { githubMcpOrigin: this.appOrigin });
    await this.store.flush();
    return this.view(saved);
  }

  /** POST refresh: list the saved server's tools again, keep them, and say what was added, removed and changed. */
  async refresh(name: string, stop?: AbortSignal) {
    const was = await this.need(name);
    const open = await this.opened(name, was, "name");
    const listed = await this.listServer(new URL(was.url), await this.withAppToken(was.auth, new URL(was.url), open.headers, stop), stop);
    const before = new Map((was.tools as McpTool[]).map((tool) => [tool.name, canonical(tool)]));
    const after = new Map(listed.tools.map((tool) => [tool.name, canonical(tool)]));
    const prices = pricesListed((was.prices ?? undefined) as McpPrices | undefined, listed.tools);
    const saved = await saveMcpServer(this.store, this.sealKey, {
      name, url: was.url, auth: was.auth, protocol: listed.protocol, tools: listed.tools, serverInfo: listed.server_info, instructions: listed.instructions ?? null,
      ...(Object.keys(prices).length ? { prices } : {}), ...(was.sealed !== null ? { credential: open.credential } : {}),
      // A refresh re-lists the tools; it keeps updated_at (not an owner edit) and the credential's time, and lets
      // listed_at move to now.
      updatedAt: was.updatedAt, credentialChangedAt: was.credentialChangedAt,
    }, { githubMcpOrigin: this.appOrigin });
    await this.store.flush();
    return {
      added: [...after.keys()].filter((tool) => !before.has(tool)),
      removed: [...before.keys()].filter((tool) => !after.has(tool)),
      changed: [...after.keys()].filter((tool) => before.has(tool) && before.get(tool) !== after.get(tool)),
      server: await this.view(saved),
    };
  }

  async remove(name: string): Promise<void> {
    await this.need(name);
    await removeMcpServer(this.store, name);
    await this.store.flush();
  }

  /** POST .../{name}/oauth/start: `{url, scopes?, client_id?, client_secret?}`; answers the URL the owner opens. */
  async oauthStart(name: string, body: Record<string, unknown>): Promise<{ authorization_url: string }> {
    nameOf(name);
    const issues = unknownFields(body, ["url", "scopes", "client_id", "client_secret"]);
    const url = urlOf(body.url, issues);
    const { scopes, client_id, client_secret } = body;
    if (scopes !== undefined && !scopesValid(scopes)) issues.push({ field: "scopes", reason: "invalid", message: SCOPE_LIST });
    for (const [field, text] of [["client_id", client_id], ["client_secret", client_secret]] as const)
      if (text !== undefined && !oauthValueValid(text)) issues.push({ field, reason: "invalid", message: `${field} is text, at most ${MAX_VALUE_BYTES} bytes.` });
    if (client_secret !== undefined && client_id === undefined) issues.push({ field: "client_id", reason: "missing", message: "A client_secret goes with the client_id it is the secret of." });
    if (issues.length) throw invalid(issues);
    const was = await this.store.mcp.server(name);
    // A body with no client_id signs in again with the client kept in the sealed token set, for the same origin only.
    const kept = typeof client_id !== "string" && was?.auth === "oauth" && new URL(was.url).origin === url!.origin ? await this.openedSet(name, was) : undefined;
    // The kept client goes with the authorization server it was registered at (keptFor): another one gets a new client.
    const keptFor = kept ? issuerOf(kept.discovery) : undefined;
    const client = typeof client_id === "string" ? { client: { client_id, ...(typeof client_secret === "string" ? { client_secret } : {}) }, kind: "pre-registered" as const } : kept && keptFor ? { client: kept.client, kind: kept.kind, keptFor } : {};
    return { authorization_url: await this.signIns.start(name, url!, { was: was ? saving(was) : null, ...(scopes ? { scope: (scopes as string[]).join(" ") } : {}), ...client }) };
  }

  /** GET .../oauth/callback: its state's sign-in finished (the code exchanged, the token set sealed, the tools listed and
   *  kept). Answers where to send the browser; 400 for a state that is unknown, used or expired. */
  oauthCallback(query: URLSearchParams, stop?: AbortSignal): Promise<string> {
    return this.track(this.callback(query, AbortSignal.any([this.stopped.signal, ...(stop ? [stop] : [])])));
  }

  private async callback(query: URLSearchParams, stop: AbortSignal): Promise<string> {
    let entry: Pending;
    try {
      entry = await this.signIns.takePending(query.get("state"));
    } catch (error) {
      if (error instanceof ApiError && error.code === "bad_request") throw error;
      return `${MCP_SETTINGS_PAGE}?sign_in=failed&error=${await reasonOf(error)}`;
    }
    const back = (error?: string) => `${MCP_SETTINGS_PAGE}?server=${entry.name}&sign_in=${error ? `failed&error=${error}` : "ok"}`;
    try {
      const error = query.get("error");
      if (error) return back(/^[a-z_]{1,64}$/.test(error) ? error : "sign_in_failed");
      const set = await this.signIns.finish(entry, query.get("code") ?? "", query.get("iss") ?? undefined, stop);
      const listed = await this.listServer(new URL(entry.url), { authorization: `Bearer ${set.tokens.access_token}` }, stop);
      const now = await this.store.mcp.server(entry.name);
      // Saved, signed in to again or forgotten since this sign-in started: that stands.
      if ((now ? saving(now) : null) !== entry.was) return back("changed_meanwhile");
      const prices = now?.url === entry.url ? ((now.prices ?? undefined) as McpPrices | undefined) : undefined;
      await saveMcpServer(this.store, this.sealKey, {
        name: entry.name, url: entry.url, auth: "oauth", protocol: listed.protocol, tools: listed.tools, serverInfo: listed.server_info, instructions: listed.instructions ?? null,
        ...(prices && Object.keys(prices).length ? { prices } : {}), credential: { type: "oauth", set },
      });
      await this.store.flush();
      return back();
    } catch (error) {
      return back(await reasonOf(error));
    }
  }

  private listServer(url: URL, headers: HeaderMap, stop?: AbortSignal): Promise<Listed> {
    // The shared probe (mcp-probe.listServer), bound also to this server's own stop.
    return listServer(url, headers, this.version, AbortSignal.any([this.stopped.signal, ...(stop ? [stop] : [])]));
  }

  private async need(name: string): Promise<McpServerRow> {
    const row = await this.store.mcp.server(name);
    if (!row) throw notFound(name);
    return row;
  }

  /** The saved credential opened, or the refusal that asks for it again (McpServers.opened). */
  private async opened(name: string, row: McpServerRow, field: string): Promise<Opened> {
    // No credential kept: none for a server that takes none, nor for a github_app server with no static headers.
    if (row.auth === "none" || row.sealed === null) return { headers: {}, credential: { type: "headers", headers: {}, origin: new URL(row.url).origin } };
    const open = await openServerCredential(this.store, this.sealKey, name);
    if (!open || !("credential" in open)) throw invalid([{ field, reason: "missing", message: `The saved credential of ${name} does not open here (sealed under another seal key, or damaged): send it again.` }]);
    const credential = open.credential;
    if (credential.type === "oauth") {
      if ((credential as { expired?: true }).expired) throw invalid([{ field, reason: "expired", message: `The sign-in to ${name} expired or was revoked: ${SIGN_IN_AGAIN}.` }]);
      return { headers: { authorization: `Bearer ${(credential.set as TokenSet).tokens.access_token}` }, credential };
    }
    return { headers: credential.headers as HeaderMap, credential };
  }

  /** The saved OAuth token set, for a sign-in again that reuses the kept client. */
  private async openedSet(name: string, row: McpServerRow): Promise<TokenSet | undefined> {
    if (row.auth !== "oauth") return undefined;
    const open = await openServerCredential(this.store, this.sealKey, name);
    return open && "credential" in open && open.credential.type === "oauth" ? (open.credential.set as TokenSet) : undefined;
  }

  private async view(row: McpServerRow) {
    const name = row.name;
    const settings = this.toolSettings();
    const tools = (row.tools as McpTool[]) ?? [];
    const prices = (row.prices ?? undefined) as McpPrices | undefined;
    const listed = marked(row.url, { protocol: row.protocol ?? "unknown", server_info: row.serverInfo ?? null, ...(typeof row.instructions === "string" ? { instructions: row.instructions } : {}), tools });
    const unmetered = tools.filter((tool) => !(prices && Object.hasOwn(prices, tool.name))).map((tool) => tool.name);
    const opened = row.auth === "none" || (row.auth === "github_app" && row.sealed === null) ? null : await openServerCredential(this.store, this.sealKey, name);
    const cred = opened && "credential" in opened ? opened.credential : undefined;
    const set = cred?.type === "oauth" ? (cred.set as TokenSet) : undefined;
    const expired = cred?.type === "oauth" && (cred as { expired?: true }).expired === true;
    const updatedAt = new Date(row.updatedAt).toISOString();
    // A refresh moves listed_at, not updated_at, so the two differ after a refresh (updatedAt for a row from before the
    // column).
    const listedAt = new Date(row.listedAt ?? row.updatedAt).toISOString();
    return {
      name,
      url: row.url,
      ...(prices && Object.keys(prices).length ? { prices } : {}),
      ...listed,
      // Each priced tool's price in USD a call, as the owner saved them (main's file registry served them on every read).
      ...(prices && Object.keys(prices).length ? { prices } : {}),
      tools: listed.tools.map((tool) => ({ ...tool, ...serverGate(`mcp:${name}/${tool.name}`, settings) })),
      ...(unmetered.length ? { not_metered: unmetered } : {}),
      auth: { type: row.auth, ...(row.auth === "headers" || row.auth === "github_app" ? { headers: Object.keys((cred?.type === "headers" ? cred.headers : {}) as HeaderMap) } : {}) },
      credential: opened === null ? null : !cred ? ("unreadable" as const) : expired ? ("expired" as const) : ("sealed" as const),
      ...(set ? { oauth: { ...(set.expires_at ? { expires_at: set.expires_at } : {}), scopes: (set.tokens.scope ?? "").split(" ").filter(Boolean), client: set.kind, ...(set.client?.client_id ? { client_id: set.client.client_id } : {}) } } : {}),
      listed_at: listedAt,
      updated_at: updatedAt,
      secret: secretOf(row),
    };
  }

  /** A body's URL, auth and prices, or 422 (McpServers.admit). */
  private admit(body: Record<string, unknown>, priced = false): { url: URL; auth: Auth; prices?: McpPrices } {
    const issues: InputIssue[] = unknownFields(body, priced ? ["url", "auth", "prices"] : ["url", "auth"]);
    const url = urlOf(body.url, issues);
    const auth = authOf(body.auth, issues);
    const prices = pricesOf(body.prices, issues);
    // The App's tokens go to GitHub alone: a github_app server is GitHub's hosted MCP, nothing else, refused in that rule's
    // words in place of any other its URL drew.
    if (url && auth?.type === "github_app" && !githubMcpUrl(url, this.appOrigin)) issues.splice(0, issues.length, ...issues.filter((issue) => issue.field !== "url"), { field: "url", reason: "not_allowed", message: GITHUB_MCP_ONLY });
    if (issues.length) throw invalid(issues);
    return { url: url!, auth: auth!, ...(prices ? { prices } : {}) };
  }

  /** `headers` and, for a github_app server, an installation token of the connected App to list its tools with. Its URL
   *  is checked first (githubMcpUrl), so a row saved at another address never gets a token minted or sent. */
  private async withAppToken(type: string, url: URL, headers: HeaderMap, stop?: AbortSignal): Promise<HeaderMap> {
    if (type !== "github_app") return headers;
    if (!githubMcpUrl(url, this.appOrigin)) throw invalid([{ field: "url", reason: "not_allowed", message: GITHUB_MCP_ONLY }]);
    const minted = this.appToken ? await this.appToken(stop) : { unusable: "This server has no GitHub App: Connect GitHub in Settings." };
    if ("unusable" in minted) throw new ApiError("github_not_connected", minted.unusable);
    if ("failed" in minted) throw new ApiError("github_failed", minted.failed);
    return { ...headers, authorization: `Bearer ${minted.token}` };
  }
}

/** Which save of a server this is: a PUT or a sign-in makes a new one (its updated time moves), a refresh of its tools or
 *  token does not change the url. The staleness key an OAuth sign-in carries from start to callback. */
const saving = (row: McpServerRow) => `${row.url} ${row.updatedAt}`;

/** The McpServers surface over the one store: the switch swaps `new McpServers(data, env, version)` for this. No load() is
 *  needed — every read goes to the store (the runner also writes the OAuth state), so a read is always current. */
export function mcpServersOverStore(store: McpServersStore, env: NodeJS.ProcessEnv, version: string, network?: OAuthNetwork): McpServersOverStore {
  return new McpServersOverStore(store, env, version, network);
}

/** The server's credential as every secret is read (SECRETS-PLAN.md): set or not, how it came ("console": pasted, a
 *  bearer token or headers; "sign-in": an OAuth sign-in; null: none), and the credential's own last change. Never a value.
 *  An MCP credential never comes from the server's environment. */
function secretOf(row: McpServerRow): SecretMeta {
  const set = row.sealed !== null && row.auth !== "none";
  return secretMeta(secretName("mcp", row.name), { set, source: row.auth === "oauth" ? "sign-in" : "console", changedAt: row.credentialChangedAt === null ? null : new Date(row.credentialChangedAt) });
}
