// OAuth sign-in to a remote MCP server, run by this server with the official SDK's `auth` (@modelcontextprotocol/client):
// RFC 9728 then RFC 8414 discovery, the client (the owner's pre-registered one; else this server's client metadata
// document, only when its address is public https; else dynamic registration), PKCE S256, the RFC 8707 resource, the
// code exchange and the refresh. What is here is only what the SDK's provider keeps: a sign-in in progress, in memory by
// its state (random, used once, ten minutes), and the token set the callback hands mcp-servers.ts to seal. No token is
// ever answered, logged or handed to the browser.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import type { OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, OAuthTokens, StoredOAuthClientInformation } from "@modelcontextprotocol/client";
import { ApiError } from "./errors.js";

/** The authorization server sends the owner's browser back here; it holds no credential, so it takes none. */
export const OAUTH_CALLBACK = "/v2/settings/mcp-servers/oauth/callback";
/** This server's client metadata document, its client id where the authorization server takes one (CIMD). */
export const OAUTH_CLIENT_DOCUMENT = "/v2/settings/mcp-servers/oauth/client.json";
/** Where the callback sends the browser: the console's MCP servers page, then `?server=<name>&sign_in=ok|failed`. */
export const MCP_SETTINGS_PAGE = "/#/settings/mcp";
/** What a person is told when a sign-in no longer works. */
export const SIGN_IN_AGAIN = "sign in again in Settings → MCP servers";
const STATE_MS = 10 * 60_000;
const MAX_PENDING = 64;
const REQUEST_MS = 15_000;
/** How long a token refresh's request may take: a run's start waits for it, two tries at most (mcp-servers.ts), so an
 *  authorization server that never answers holds a start's answer no more than about eight seconds, well under a
 *  client's timeout, and its call is then refused unsent, saying to try again. */
export const REFRESH_REQUEST_MS = 4_000;

export type ClientKind = "pre-registered" | "metadata-document" | "dynamic";
/** What is sealed: the tokens and all a refresh needs. */
export type TokenSet = { tokens: OAuthTokens; obtained_at: string; expires_at?: string; client: StoredOAuthClientInformation; kind: ClientKind; discovery: OAuthDiscoveryState; resource?: string };
type Pending = { name: string; url: string; was: string | null; scope?: string; kind: ClientKind; client?: StoredOAuthClientInformation; verifier?: string; discovery?: OAuthDiscoveryState; resource?: string; expires: number };

const sdk = () => import("@modelcontextprotocol/client");
/** How the authorization server of an MCP server off loopback is reached: every address a name resolves to, and a
 *  request dialled at the one address that was checked. Tests give their own; the default is the system resolver and
 *  undici dialled through pi-browser's pinnedLookup. */
export type OAuthNetwork = {
  lookup(host: string): Promise<string[]>;
  fetch(url: string, init: RequestInit, address: string): Promise<Response>;
};
const MAX_ANSWER_BYTES = 2 ** 20;
export const systemNetwork: OAuthNetwork = {
  lookup: async (host) => (await dns.lookup(host, { all: true })).map((one) => one.address),
  // Dialled at `address` whatever the name resolves to by then (pinnedLookup answers it for every name), and read
  // whole (at most MAX_ANSWER_BYTES) before the connection closes.
  async fetch(url, init, address) {
    const [{ Agent, fetch: send }, { pinnedLookup }] = await Promise.all([import("undici"), import("@parcha/pi-browser")]);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(address) as never } });
    try {
      const res = await send(url, { ...(init as object), dispatcher } as never);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (const reader = res.body?.getReader(); reader; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if ((size += value.length) > MAX_ANSWER_BYTES) throw new Error(`the authorization server answered more than ${MAX_ANSWER_BYTES} bytes`);
        chunks.push(value);
      }
      const empty = [101, 204, 205, 304].includes(res.status);
      return new Response(empty ? null : Buffer.concat(chunks), { status: res.status, statusText: res.statusText, headers: new Headers([...res.headers]) });
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  },
};

/** What a sign-in's requests met, for its answer: the first refusal, else the last endpoint that failed (its status,
 *  when it answered). Never what an authorization server said: its words are not passed on. */
type Seen = { refused?: string; failed?: { what: string; status?: number; why?: string } };

/** The authorization server's requests: no redirect followed (a code or secret goes only where discovery said), each
 *  held to REQUEST_MS (a refresh's to REFRESH_REQUEST_MS), and stopped with `stop` (the server's own stop). None goes to a private or link-local address or
 *  over plain http (checked), and each is dialled at the address checked: its authorization server cannot steer this
 *  server's code, verifier, secret or refresh token to a service on this machine or its network, by its metadata or by
 *  its name's next answer. The one exception, for development and tests, is a loopback MCP server's (`mcpUrl`): its
 *  authorization server may be on the same loopback host, never another loopback address nor this server's own ports
 *  (`own`: where it listens, and its public address when that is on loopback), so it cannot reach this server. It CAN
 *  reach other ports on that same loopback host, blind (endpoint and status only), by design: development only (loopbackAllowed). */
const guarded = (stop: AbortSignal | undefined, mcpUrl: string, network: OAuthNetwork, seen: Seen = {}, own: readonly string[] = [], ms = REQUEST_MS) => async (input: string | URL | Request, init?: RequestInit) => {
  // Started before the address check: its name lookup is bounded by the same timeout and the server's stop.
  const signal = AbortSignal.any([AbortSignal.timeout(ms), ...(stop ? [stop] : []), ...(init?.signal ? [init.signal] : [])]);
  const url = new URL(input instanceof Request ? input.url : String(input));
  const what = `endpoint ${url.origin}${url.pathname}`;
  if (loopbackAllowed(url, mcpUrl, own)) return noted(fetch(input, { ...init, redirect: "manual", signal }), what, seen);
  let at: Awaited<ReturnType<typeof checked>>;
  try {
    at = await checked(what, url.href, signal, network);
  } catch (error) {
    // Its address check outlived the request's time (a name lookup that never answered), or the server stopped: the
    // endpoint is noted, never the error's own words.
    seen.failed = { what, ...(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? { why: "DNS lookup timed out" } : {}) };
    throw error;
  }
  if ("refused" in at) {
    seen.refused ??= at.refused;
    throw new Error(at.refused);
  }
  return noted(network.fetch(url.href, { ...init, redirect: "manual", signal }, at.address), what, seen);
};
/** `sent`'s answer, an endpoint that failed (or answered 4xx/5xx) noted in `seen`. */
async function noted(sent: Promise<Response>, what: string, seen: Seen): Promise<Response> {
  try {
    const res = await sent;
    if (res.status >= 400) seen.failed = { what, status: res.status };
    return res;
  } catch (error) {
    seen.failed = { what };
    throw error;
  }
}
const portOf = (url: URL) => Number(url.port || (url.protocol === "https:" ? 443 : 80));
/** Whether `url` is an endpoint a loopback MCP server's authorization server may use on loopback (a development-only
 *  allowance): the MCP server's own loopback host exactly as it is written (never another loopback address, the IPv6
 *  loopback, or a name for this machine in its place), on any port but this server's own (`own`: where it listens,
 *  and its public address when that is on loopback too, as a local https proxy in front of it is). Any other loopback
 *  endpoint is checked as any address is, and refused. Other ports on that same loopback host stay reachable, blind
 *  (endpoint and status only): that is why the allowance is for development only. */
function loopbackAllowed(url: string | URL, mcpUrl: string, own: readonly string[]): boolean {
  const at = typeof url === "string" ? URL.parse(url) : url;
  const mcp = URL.parse(mcpUrl);
  if (!at || !mcp || !LOOPBACK.test(mcp.hostname) || at.hostname !== mcp.hostname) return false;
  return !own.some((address) => {
    const self = URL.parse(address);
    return self !== null && portOf(self) === portOf(at);
  });
}

/** `url`, which the authorization server named as its `what`, for an MCP server off loopback: refused when it is on
 *  this machine or a private network, by name or by any address its name resolves to (pi-browser's isPrivateAddress,
 *  the check the agent's own web fetch uses), when its name does not resolve (fail closed), or when it is not https;
 *  else the address checked, the one a request to it is dialled at. */
async function checked(what: string, url: string, signal: AbortSignal, network: OAuthNetwork): Promise<{ refused: string } | { address: string }> {
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return { refused: `the authorization server's ${what} is not a URL; refused` };
  }
  const { isPrivateAddress } = await import("@parcha/pi-browser");
  const host = at.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (LOOPBACK.test(at.hostname)) addresses = [];
  else if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = await raced(network.lookup(host), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return { refused: `couldn't resolve the authorization server's ${what}; refused` };
    }
    if (!addresses.length) return { refused: `couldn't resolve the authorization server's ${what}; refused` };
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) return { refused: `the authorization server's ${what} is a private address; refused` };
  if (at.protocol !== "https:") return { refused: `the authorization server's ${what} is not https; refused` };
  return { address: addresses[0]! };
}

/** `work`, or `signal`'s reason as soon as it aborts: a resolver that never answers holds nothing past it. */
const raced = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });

/** Every endpoint discovery found, checked as `checked` does, before any is used; a loopback one passes only as
 *  loopbackAllowed lets it, for a loopback MCP server (`mcpUrl`). */
async function discoveryRefusal(state: OAuthDiscoveryState, network: OAuthNetwork, mcpUrl: string, own: readonly string[]): Promise<string | undefined> {
  const signal = AbortSignal.timeout(REQUEST_MS);
  const metadata = state.authorizationServerMetadata;
  const named: Array<[string, string | undefined]> = [["address", state.authorizationServerUrl], ["metadata address", state.resourceMetadataUrl], ["authorization endpoint", metadata?.authorization_endpoint], ["token endpoint", metadata?.token_endpoint], ["registration endpoint", metadata?.registration_endpoint]];
  for (const [what, url] of named) {
    if (url && loopbackAllowed(url, mcpUrl, own)) continue;
    const at = url ? await checked(what, url, signal, network) : undefined;
    if (at && "refused" in at) return at.refused;
  }
  return undefined;
}

const SIGN_IN_COOKIE = "agentrun-oauth";
const digest = (text: string) => createHash("sha256").update(text).digest();
/** One cookie per sign-in, named by its state, so two tabs signing in at once do not replace each other's. */
const cookieName = (port: number | undefined, state: string) => `${SIGN_IN_COOKIE}-${port}-${digest(state).toString("hex").slice(0, 16)}`;
/** The cookie a start sets in the starting browser, and its callback asks for: the callback runs only in the browser
 *  that started the sign-in. SameSite=Lax, so the authorization server's redirect back (a top-level GET from another
 *  site) carries it, which the console's Strict cookies are not; its path is the callback's alone. */
export const signInCookie = (port: number | undefined, state: string, https: boolean, maxAge = STATE_MS / 1000) =>
  `${cookieName(port, state)}=${maxAge ? state : ""}; HttpOnly; SameSite=Lax; Path=${OAUTH_CALLBACK}; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
/** Whether the callback's request carries the cookie its state's start set. */
export const startedHere = (cookies: string | undefined, port: number | undefined, state: string | null): boolean => {
  if (!state) return false;
  const name = `${cookieName(port, state)}=`;
  return String(cookies ?? "").split(";").map((part) => part.trim()).some((part) => part.startsWith(name) && timingSafeEqual(digest(part.slice(name.length)), digest(state)));
};
const expiresAt = (tokens: OAuthTokens) => (tokens.expires_in !== undefined ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined);
const LOOPBACK = /^(?:localhost|\[::1\]|127(?:[.]\d{1,3}){3})$/; // key-gate: loopback-rule CIMD is never offered from loopback, and only a loopback MCP server may name loopback endpoints

export class McpSignIns {
  constructor(private readonly network: OAuthNetwork = systemNetwork) {}

  private readonly pending = new Map<string, Pending>();
  /** This server's address as a browser reaches it (AGENTRUN_PUBLIC_URL, else where it listens), no trailing slash:
   *  set by McpServers.attach as the server starts listening. */
  base = "";
  /** Where this server listens (`http://<host>:<port>`), whatever `base` is: its port is never an endpoint a loopback
   *  authorization server may name. Set by McpServers.attach. */
  listening = "";
  /** This server's own local addresses, whose ports a loopback authorization server may never name: where it listens,
   *  and its public address too when that is on loopback (a local proxy in front of the listener, such as
   *  https://localhost:8443, reaches this server). */
  get own(): string[] {
    const base = URL.parse(this.base);
    return [this.listening, ...(base && LOOPBACK.test(base.hostname) ? [this.base] : [])].filter(Boolean);
  }

  /** CIMD only from a public https address: an authorization server must be able to fetch the document. */
  private get metadataUrl(): string | undefined {
    if (!this.base.startsWith("https://")) return undefined;
    return !LOOPBACK.test(new URL(this.base).hostname) ? `${this.base}${OAUTH_CLIENT_DOCUMENT}` : undefined;
  }

  clientMetadata(): OAuthClientMetadata {
    return { client_name: "agentrun", redirect_uris: [`${this.base}${OAUTH_CALLBACK}`], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }

  /** GET OAUTH_CLIENT_DOCUMENT: the client metadata document, its own URL as its client id. */
  clientDocument() {
    return { client_id: `${this.base}${OAUTH_CLIENT_DOCUMENT}`, ...this.clientMetadata() };
  }

  /** Discovery, the client, PKCE and the state: the URL the owner opens to say yes. */
  async start(name: string, url: URL, options: { was: string | null; scope?: string; client?: StoredOAuthClientInformation; kind?: ClientKind }): Promise<string> {
    const now = Date.now();
    for (const [state, entry] of this.pending) if (entry.expires <= now || this.pending.size >= MAX_PENDING) this.pending.delete(state);
    const state = randomBytes(32).toString("base64url");
    const entry: Pending = { name, url: url.href, was: options.was, ...(options.scope ? { scope: options.scope } : {}), kind: options.kind ?? "dynamic", ...(options.client ? { client: options.client } : {}), expires: now + STATE_MS };
    let opened: URL | undefined;
    const seen: Seen = {};
    const provider = this.provider(entry, { state, redirect: (to) => void (opened = to), seen });
    try {
      await (await sdk()).auth(provider, { serverUrl: url, ...(options.scope ? { scope: options.scope } : {}), fetchFn: guarded(undefined, url.href, this.network, seen, this.own) });
    } catch (error) {
      // Named by the endpoint and its status, never by what the authorization server said: its answer is not passed on.
      const { OAuthError } = await sdk();
      const why = seen.refused ?? (seen.failed ? `its authorization server's ${seen.failed.what} ${seen.failed.status ? `answered HTTP ${seen.failed.status}` : `could not be reached${seen.failed.why ? ` (${seen.failed.why})` : ""}`}` : error instanceof OAuthError && /^[a-z_]{1,64}$/.test(String(error.code)) ? `its authorization server refused it (${error.code})` : "its authorization server's answer was not one it could use");
      throw new ApiError("upstream_failed", `The sign-in to ${url.origin} did not start: ${why}.`);
    }
    if (!opened) throw new ApiError("upstream_failed", `The sign-in to ${url.origin} did not start: its authorization server gave no page to open.`);
    if (entry.client?.client_id === provider.clientMetadataUrl) entry.kind = "metadata-document";
    this.pending.set(state, entry);
    return opened.href;
  }

  /** The callback's sign-in, by its state: once, and only within ten minutes of its start. `was` is the server's save
   *  when it started (null for none), so a sign-in the owner since replaced or forgot is not written back. */
  take(state: string | null): Pending {
    const entry = state ? this.pending.get(state) : undefined;
    if (state) this.pending.delete(state);
    if (!entry || entry.expires <= Date.now()) throw new ApiError("bad_request", `This sign-in link was used already, is older than ${STATE_MS / 60_000} minutes, or is not this server's: start the sign-in again in Settings → MCP servers.`);
    return entry;
  }

  /** The code exchanged (with the verifier and the client the start kept) for the token set to seal. */
  async finish(entry: Pending, code: string, iss: string | undefined, stop?: AbortSignal): Promise<TokenSet> {
    let tokens: OAuthTokens | undefined;
    const provider = this.provider(entry, { saved: (got) => void (tokens = got) });
    await (await sdk()).auth(provider, { serverUrl: entry.url, authorizationCode: code, ...(iss ? { iss } : {}), fetchFn: guarded(stop, entry.url, this.network, {}, this.own) });
    if (!tokens || !entry.client || !entry.discovery) throw new ApiError("upstream_failed", "The authorization server gave no tokens.");
    const scope = tokens.scope ?? entry.scope;
    return { tokens: { ...tokens, ...(scope ? { scope } : {}) }, obtained_at: new Date().toISOString(), ...(expiresAt(tokens) ? { expires_at: expiresAt(tokens) } : {}), client: entry.client, kind: entry.kind, discovery: entry.discovery, ...(entry.resource ? { resource: entry.resource } : {}) };
  }

  private provider(entry: Pending, hooks: { state?: string; redirect?: (url: URL) => void; saved?: (tokens: OAuthTokens) => void; seen?: Seen }): OAuthClientProvider {
    const metadataUrl = entry.kind === "pre-registered" ? undefined : this.metadataUrl;
    return {
      redirectUrl: `${this.base}${OAUTH_CALLBACK}`,
      ...(metadataUrl ? { clientMetadataUrl: metadataUrl } : {}),
      clientMetadata: this.clientMetadata(),
      state: () => hooks.state ?? "",
      clientInformation: () => entry.client,
      saveClientInformation: (client) => void (entry.client = client),
      tokens: () => undefined,
      saveTokens: (tokens) => hooks.saved?.(tokens),
      redirectToAuthorization: (url) => hooks.redirect?.(url),
      saveCodeVerifier: (verifier) => void (entry.verifier = verifier),
      codeVerifier: () => entry.verifier ?? "",
      // Checked before anything discovery found is used: registration, the page the owner opens, the code exchange.
      saveDiscoveryState: async (state) => {
        const why = await discoveryRefusal(state, this.network, entry.url, this.own);
        if (why) {
          if (hooks.seen) hooks.seen.refused ??= why;
          throw new Error(why);
        }
        entry.discovery = state;
      },
      discoveryState: () => entry.discovery,
      saveResourceUrl: (resource) => void (entry.resource = resource),
    };
  }
}

/** `set` refreshed at its authorization server, the refresh token kept when none new is given. */
export async function refreshed(set: TokenSet, mcpUrl: string, stop?: AbortSignal, network: OAuthNetwork = systemNetwork, own: readonly string[] = []): Promise<TokenSet> {
  const tokens = await (await sdk()).refreshAuthorization(set.discovery.authorizationServerUrl, {
    ...(set.discovery.authorizationServerMetadata ? { metadata: set.discovery.authorizationServerMetadata } : {}),
    clientInformation: set.client,
    refreshToken: set.tokens.refresh_token!,
    ...(set.resource ? { resource: set.resource } : {}),
    fetchFn: guarded(stop, mcpUrl, network, {}, own, REFRESH_REQUEST_MS),
  });
  const scope = tokens.scope ?? set.tokens.scope;
  const { expires_at: _, ...rest } = set;
  return { ...rest, tokens: { ...tokens, ...(scope ? { scope } : {}) }, obtained_at: new Date().toISOString(), ...(expiresAt(tokens) ? { expires_at: expiresAt(tokens) } : {}) };
}

/** Whether a refresh failed because the authorization server said no (revoked, expired, client gone), not for want of
 *  reaching it: only then is a person asked to sign in again. */
export async function refused(error: unknown): Promise<boolean> {
  const { OAuthError } = await sdk();
  return error instanceof OAuthError && ["invalid_grant", "invalid_client", "unauthorized_client"].includes(error.code);
}

/** A failed sign-in's reason for the console's page: an OAuth error code, or ours. */
export async function reasonOf(error: unknown): Promise<string> {
  const { OAuthError } = await sdk();
  const code = error instanceof OAuthError || error instanceof ApiError ? String(error.code) : "sign_in_failed";
  return /^[a-z_]{1,64}$/.test(code) ? code : "sign_in_failed";
}
