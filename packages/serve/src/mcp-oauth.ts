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
import { ApiError, invalid } from "./errors.js";
import { hostKey } from "./mcp-meta.js";
import { localAddresses, PRIVATE_HOSTS_PAGE, privateAllowed } from "./mcp-private-hosts.js";

/** The authorization server sends the owner's browser back here; it holds no credential, so it takes none. */
export const OAUTH_CALLBACK = "/v2/settings/mcp-servers/oauth/callback";
/** This server's client metadata document, its client id where the authorization server takes one (CIMD). */
export const OAUTH_CLIENT_DOCUMENT = "/v2/settings/mcp-servers/oauth/client.json";
/** Where the callback sends the browser: the console's MCP servers page, then `?server=<name>&sign_in=ok|failed`. */
export const MCP_SETTINGS_PAGE = "/#/settings/mcp";
/** What a person is told when a sign-in no longer works. */
export const SIGN_IN_AGAIN = "sign in again in Settings → MCP servers";
const STATE_MS = 10 * 60_000;
/** The most sign-ins that may be in flight at once: the in-memory map evicts to it, and the store-backed one refuses past it. */
export const MAX_PENDING = 64;
const REQUEST_MS = 15_000;
/** How long a token refresh's request may take: a run's start waits for it, two tries at most (mcp-servers.ts), so an
 *  authorization server that never answers holds a start's answer no more than about eight seconds, well under a
 *  client's timeout, and its call is then refused unsent, saying to try again. */
export const REFRESH_REQUEST_MS = 4_000;

export type ClientKind = "pre-registered" | "metadata-document" | "dynamic";
/** What is sealed: the tokens and all a refresh needs. */
export type TokenSet = { tokens: OAuthTokens; obtained_at: string; expires_at?: string; client: StoredOAuthClientInformation; kind: ClientKind; discovery: OAuthDiscoveryState; resource?: string };
/** `keptFor`: the authorization server (its issuer) a client kept from an earlier sign-in was registered at; the client is
 *  used again only when discovery finds that same one (else it is dropped, and the sign-in registers anew). */
export type Pending = { name: string; url: string; was: string | null; scope?: string; kind: ClientKind; client?: StoredOAuthClientInformation; keptFor?: string; verifier?: string; discovery?: OAuthDiscoveryState; resource?: string; expires: number };

/** The authorization server a discovery found, by its issuer (its metadata's, else its URL). */
export const issuerOf = (state: { authorizationServerUrl?: string; authorizationServerMetadata?: { issuer?: string } } | undefined): string | undefined => state?.authorizationServerMetadata?.issuer ?? state?.authorizationServerUrl;

/** Where sign-ins in flight are kept between start and callback. The default is in-memory (one server per process); the
 *  store-backed server (mcp-servers-store.ts) passes one over store.mcpOauth, so a sign-in survives a restart and the
 *  verifier is sealed at rest. `set` evicts what has expired (and enforces the cap) before it writes. */
export interface PendingStore {
  set(state: string, entry: Pending): Promise<void>;
  take(state: string): Promise<Pending | undefined>;
}

const sdk = () => import("@modelcontextprotocol/client");
/** How the authorization server of an MCP server off loopback, and an MCP server itself, is reached: every address a
 *  name resolves to, and a request dialled at the one address that was checked. Tests give their own; the default is the
 *  system resolver and undici dialled through pi-browser's pinnedLookup. `local`: this machine's own addresses, never
 *  dialled even for a host the owner allows on a private network; omitted, this machine's network interfaces'
 *  (localAddresses). `dial`: a request to an MCP server at the address checked, its answer streamed as it comes (an MCP
 *  server's event stream may stay open); omitted, `fetch`. */
export type OAuthNetwork = {
  lookup(host: string): Promise<string[]>;
  fetch(url: string, init: RequestInit, address: string): Promise<Response>;
  local?(): readonly string[];
  dial?(url: string, init: RequestInit, address: string): Promise<Response>;
};
const MAX_ANSWER_BYTES = 2 ** 20;
export const systemNetwork: OAuthNetwork = {
  lookup: async (host) => (await dns.lookup(host, { all: true })).map((one) => one.address),
  local: localAddresses,
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
  // Dialled at `address` as fetch is, its answer handed on unread: the connection is let go once that answer has been
  // read or dropped (undici's close waits for the request in flight).
  async dial(url, init, address) {
    const [{ Agent, fetch: send }, { pinnedLookup }] = await Promise.all([import("undici"), import("@parcha/pi-browser")]);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(address) as never } });
    try {
      const res = await send(url, { ...(init as object), dispatcher } as never);
      void dispatcher.close().catch(() => undefined);
      const empty = [101, 204, 205, 304].includes(res.status);
      return new Response(empty ? null : (res.body as ReadableStream<Uint8Array> | null), { status: res.status, statusText: res.statusText, headers: new Headers([...res.headers]) });
    } catch (error) {
      await dispatcher.close().catch(() => undefined);
      throw error;
    }
  },
};

/** A request the address check refused before anything was sent (checked's words): no try again reaches it. */
export class EndpointRefused extends Error {
  override name = "EndpointRefused";
}

/** A request that provably never left: its address check outlived its time or was stopped, or its connection was refused
 *  or never made (no route, no such name). Only such a request may be tried again: one that left may have spent a
 *  refresh token already. */
export class RequestUnsent extends Error {
  override name = "RequestUnsent";
}

/** The connect-time failures (in an error or any of its causes): nothing of the request reached the server. */
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
function connectFailed(error: unknown): boolean {
  for (let at = error, depth = 0; at && typeof at === "object" && depth < 5; at = (at as { cause?: unknown }).cause, depth++) {
    if (CONNECT_FAILURES.has(String((at as { code?: unknown }).code))) return true;
  }
  return false;
}

/** What a sign-in's requests met, for its answer: the first refusal, else the last endpoint that failed (its status,
 *  when it answered). Never what an authorization server said: its words are not passed on. */
export type Seen = { refused?: string; failed?: { what: string; status?: number; why?: string } };

/** Where a sign-in's or refresh's requests, or an MCP server's own, may go besides a public address: `own`, this server's
 *  own addresses (where it listens, and its public address when that is on loopback); `allowed`, the private-network
 *  hosts the owner allows (mcp-private-hosts.ts privateOAuthHosts, read once per sign-in step, refresh or MCP request).
 *  `loopback`: an MCP server's URL on loopback (as written, mcpServerAt) may be dialled, on any port but `own`'s: a
 *  server that is a local install (it listens on loopback alone, with no public address), and the runner, which dials
 *  only what such a server admitted. */
export type Reach = { own?: readonly string[]; allowed?: readonly string[]; loopback?: boolean };

/** The authorization server's requests: no redirect followed (a code or secret goes only where discovery said), each
 *  held to REQUEST_MS (a refresh's to REFRESH_REQUEST_MS), and stopped with `stop` (the server's own stop). None goes to a private or link-local address or
 *  over plain http (checked), and each is dialled at the address checked: its authorization server cannot steer this
 *  server's code, verifier, secret or refresh token to a service on this machine or its network, by its metadata or by
 *  its name's next answer. A host the owner allows (`reach.allowed`) may be on a private network, as `checked` says.
 *  The one exception, for development and tests, is a loopback MCP server's (`mcpUrl`): its
 *  authorization server may be on the same loopback host, never another loopback address nor this server's own ports
 *  (`reach.own`), so it cannot reach this server. It CAN reach other ports on that same loopback host, blind (endpoint
 *  and status only), by design: development only (loopbackAllowed). */
const guarded = (stop: AbortSignal | undefined, mcpUrl: string, network: OAuthNetwork, seen: Seen = {}, reach: Reach = {}, ms = REQUEST_MS, sentWithin?: AbortSignal) => async (input: string | URL | Request, init?: RequestInit) => {
  // Started before the address check: its name lookup is bounded by the same timeout and the server's stop.
  const signal = AbortSignal.any([AbortSignal.timeout(ms), ...(stop ? [stop] : []), ...(init?.signal ? [init.signal] : [])]);
  // Once dialled, a request with `sentWithin` (a token refresh) is held to that alone: never cut short by its own time or
  // a stop, since it may already have spent the refresh token; one that provably never left says so (RequestUnsent).
  const sending = sentWithin ? AbortSignal.any([sentWithin, ...(init?.signal ? [init.signal] : [])]) : signal;
  const sent = (request: Promise<Response>): Promise<Response> =>
    sentWithin ? request.catch((error: unknown) => Promise.reject(connectFailed(error) ? new RequestUnsent("the connection was not made", { cause: error }) : error)) : request;
  const url = new URL(input instanceof Request ? input.url : String(input));
  const what = `endpoint ${url.origin}${url.pathname}`;
  if (loopbackAllowed(url, mcpUrl, reach.own ?? [])) return noted(sent(fetch(input, { ...init, redirect: "manual", signal: sending })), what, seen);
  let at: Awaited<ReturnType<typeof checked>>;
  try {
    at = await checked(`the authorization server's ${what}`, url.href, signal, network, reach);
  } catch (error) {
    // Its address check outlived the request's time (a name lookup that never answered), or the server stopped: the
    // endpoint is noted, never the error's own words. Nothing was sent.
    seen.failed = { what, ...(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? { why: "DNS lookup timed out" } : {}) };
    throw sentWithin ? new RequestUnsent("its address was not checked in time", { cause: error }) : error;
  }
  if ("refused" in at) {
    seen.refused ??= at.refused;
    throw new EndpointRefused(at.refused);
  }
  return noted(sent(network.fetch(url.href, { ...init, redirect: "manual", signal: sending }, at.address)), what, seen);
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

/** `url`, which `subject` names (the authorization server's endpoint for an MCP server off loopback, or an MCP server
 *  itself, mcpServerAt), in the words its refusal says: refused when it is on
 *  this machine or a private network, by name or by any address its name resolves to (pi-browser's isPrivateAddress,
 *  the check the agent's own web fetch uses), when its name does not resolve (fail closed), or when it is not https;
 *  else the address checked, the one a request to it is dialled at. A host the owner allows (`reach.allowed`, compared
 *  as hostKey keeps it) may resolve to private-network addresses, each held to privateAllowed: never loopback,
 *  link-local, unspecified, multicast or broadcast, never this machine's (`network.local`) nor this server's own
 *  (`reach.own`). Every address its name resolves to must pass, and the one dialled is one checked. An unlisted host
 *  whose private addresses the list could allow is refused in words that name it and where to allow it. */
async function checked(subject: string, url: string, signal: AbortSignal, network: OAuthNetwork, reach: Reach = {}): Promise<{ refused: string; unresolved?: true } | { address: string }> {
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return { refused: `${subject} is not a URL; refused` };
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
      return { refused: `couldn't resolve ${subject}; refused`, unresolved: true };
    }
    if (!addresses.length) return { refused: `couldn't resolve ${subject}; refused`, unresolved: true };
  }
  if (!addresses.length) return { refused: `${subject} is a private address; refused` };
  const inside = addresses.filter(isPrivateAddress);
  if (inside.length) {
    const own = [...(network.local ?? localAddresses)(), ...(reach.own ?? []).map((one) => URL.parse(one)?.hostname.replace(/^\[|\]$/g, "") ?? "")];
    if (!inside.every((address) => privateAllowed(address, own))) return { refused: `${subject} is a private address; refused` };
    const named = hostKey(at.hostname);
    // Allowing it helps only an https endpoint: a plain-http one keeps the private-address words.
    if (!(reach.allowed ?? []).includes(named)) return { refused: at.protocol === "https:" ? `${subject} is on a private network, refused: an owner can allow ${named} in ${PRIVATE_HOSTS_PAGE}` : `${subject} is a private address; refused` };
  }
  if (at.protocol !== "https:") return { refused: `${subject} is not https; refused` };
  return { address: addresses[0]! };
}

/** Where a request to the MCP server at `url` may go, before anything is sent to it: the preview, the save, the tools'
 *  refresh and the sign-in on this server, and each request of a run's calls on the runner. The rule is `checked`'s, the
 *  one an authorization server's endpoint is held to: a public https address; a private-network one only for a host the
 *  owner allows (`reach.allowed`), never loopback, link-local (cloud metadata among it) or this machine's own; every
 *  address its name resolves to checked, and the one dialled is one checked (`address`; dialAt). The one exception is a
 *  URL on loopback as written (localhost, 127.0.0.0/8, [::1]) where `reach.loopback` allows it, on any port but this
 *  server's own (`reach.own`): `address` is then undefined and it is dialled as written. `unresolved`: its name did not
 *  resolve, so nothing could be sent. */
export async function mcpServerAt(url: URL, signal: AbortSignal, network: OAuthNetwork, reach: Reach = {}): Promise<{ refused: string; unresolved?: true } | { address: string | undefined }> {
  if (reach.loopback && loopbackAllowed(url, url.href, reach.own ?? [])) return { address: undefined };
  return checked(`the MCP server at ${url.host}`, url.href, signal, network, reach);
}

/** A fetch to the MCP server `mcpServerAt` checked: dialled at `address` (the network's dial, else its fetch), or as
 *  written when there is none (a loopback URL a local install allows), through `plain`. */
export const dialAt = (network: OAuthNetwork, address: string | undefined, plain: typeof fetch = fetch) => (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  if (address === undefined) return plain(input, init);
  const url = input instanceof Request ? input.url : String(input);
  return (network.dial ?? network.fetch).call(network, url, init, address);
};

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
async function discoveryRefusal(state: OAuthDiscoveryState, network: OAuthNetwork, mcpUrl: string, reach: Reach): Promise<string | undefined> {
  const signal = AbortSignal.timeout(REQUEST_MS);
  const metadata = state.authorizationServerMetadata;
  const named: Array<[string, string | undefined]> = [["address", state.authorizationServerUrl], ["metadata address", state.resourceMetadataUrl], ["authorization endpoint", metadata?.authorization_endpoint], ["token endpoint", metadata?.token_endpoint], ["registration endpoint", metadata?.registration_endpoint]];
  for (const [what, url] of named) {
    if (url && loopbackAllowed(url, mcpUrl, reach.own ?? [])) continue;
    const at = url ? await checked(`the authorization server's ${what}`, url, signal, network, reach) : undefined;
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
/** A URL's hostname on loopback as written (localhost, 127.0.0.0/8, [::1]). */
/** A sign-in that needs a Client ID entered by hand: its authorization server lets no app register itself. GitHub's
 *  hosted MCP is named, since its login is GitHub's. */
function registrationUnavailable(url: URL): ApiError {
  const github = /(?:^|\.)github\.com$/.test(url.hostname) || url.hostname === "api.githubcopilot.com";
  return invalid([{ field: "client_id", reason: "registration_unavailable", message: `${url.host} doesn't let apps register themselves: ${github ? "create an OAuth App on GitHub" : "create an OAuth app with that provider"} and enter its Client ID and Secret here.` }]);
}

export const LOOPBACK = /^(?:localhost|\[::1\]|127(?:[.]\d{1,3}){3})$/; // key-gate: loopback-rule CIMD is never offered from loopback, and only a loopback MCP server may name loopback endpoints

export class McpSignIns {
  /** `pendingStore`: where sign-ins in flight are kept. Omitted, an in-memory map (the file server); the store server
   *  passes one over store.mcpOauth. `allowed`: the private-network hosts the owner allows (privateOAuthHosts), read
   *  at a sign-in's start and again at its callback; omitted, none. */
  constructor(private readonly network: OAuthNetwork = systemNetwork, private readonly pendingStore?: PendingStore, private readonly allowed: () => Promise<readonly string[]> = async () => []) {}

  private readonly pending = new Map<string, Pending>();
  /** This server's address as a browser reaches it (AGENTRUN_PUBLIC_URL, else where it listens), no trailing slash:
   *  set by McpServers.attach as the server starts listening. */
  base = "";
  /** Where this server listens (`http://<host>:<port>`), whatever `base` is: its port is never an endpoint a loopback
   *  authorization server may name. Set by McpServers.attach. */
  listening = "";
  /** This server's own local addresses, whose ports a loopback authorization server may never name: where it listens,
   *  and its public address too when that is on loopback (a local https proxy on another port, in front of the
   *  listener, reaches this server). */
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

  /** Whether a sign-in at `url` can bring its own client, with no Client ID entered: its authorization server's metadata
   *  names a registration endpoint (dynamic client registration), or says it takes a client metadata document and this
   *  server can offer one. Read by the same discovery a start makes, behind the same guard; `registration: false` when it
   *  publishes no metadata or the metadata offers neither. undefined when the discovery could not be made (refused,
   *  unreachable, not OAuth): the start's own words say why. */
  async registration(url: URL): Promise<{ registration: boolean } | undefined> {
    const reach: Reach = { own: this.own, allowed: await this.allowed() };
    const seen: Seen = {};
    let metadata: { registration_endpoint?: unknown; client_id_metadata_document_supported?: unknown } | undefined;
    try {
      metadata = (await (await sdk()).discoverOAuthServerInfo(url, { fetchFn: guarded(undefined, url.href, this.network, seen, reach) })).authorizationServerMetadata as typeof metadata;
    } catch {
      return undefined;
    }
    if (seen.refused) return undefined;
    return { registration: Boolean(metadata?.registration_endpoint) || Boolean(metadata?.client_id_metadata_document_supported && this.metadataUrl) };
  }

  /** Discovery, the client, PKCE and the state: the URL the owner opens to say yes. */
  async start(name: string, url: URL, options: { was: string | null; scope?: string; client?: StoredOAuthClientInformation; kind?: ClientKind; keptFor?: string }): Promise<string> {
    const now = Date.now();
    if (!this.pendingStore) for (const [state, entry] of this.pending) if (entry.expires <= now || this.pending.size >= MAX_PENDING) this.pending.delete(state);
    const state = randomBytes(32).toString("base64url");
    const entry: Pending = { name, url: url.href, was: options.was, ...(options.scope ? { scope: options.scope } : {}), kind: options.kind ?? "dynamic", ...(options.client ? { client: options.client } : {}), ...(options.keptFor ? { keptFor: options.keptFor } : {}), expires: now + STATE_MS };
    let opened: URL | undefined;
    const seen: Seen = {};
    const reach: Reach = { own: this.own, allowed: await this.allowed() };
    const provider = this.provider(entry, reach, { state, redirect: (to) => void (opened = to), seen });
    // With no client entered, the authorization server must let this app register itself: one that doesn't (a code
    // host's login, with no metadata or no registration endpoint) is said up front, on the field that fixes it.
    if (!options.client && (await this.registration(url))?.registration === false) throw registrationUnavailable(url);
    try {
      await (await sdk()).auth(provider, { serverUrl: url, ...(options.scope ? { scope: options.scope } : {}), fetchFn: guarded(undefined, url.href, this.network, seen, reach) });
    } catch (error) {
      // Named by the endpoint and its status, never by what the authorization server said: its answer is not passed on.
      const { OAuthError } = await sdk();
      const why = seen.refused ?? (seen.failed ? `its authorization server's ${seen.failed.what} ${seen.failed.status ? `answered HTTP ${seen.failed.status}` : `could not be reached${seen.failed.why ? ` (${seen.failed.why})` : ""}`}` : error instanceof OAuthError && /^[a-z_]{1,64}$/.test(String(error.code)) ? `its authorization server refused it (${error.code})` : "its authorization server's answer was not one it could use");
      throw new ApiError("upstream_failed", `The sign-in to ${url.origin} did not start: ${why}.`);
    }
    if (!opened) throw new ApiError("upstream_failed", `The sign-in to ${url.origin} did not start: its authorization server gave no page to open.`);
    if (entry.client?.client_id === provider.clientMetadataUrl) entry.kind = "metadata-document";
    if (this.pendingStore) await this.pendingStore.set(state, entry);
    else this.pending.set(state, entry);
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

  /** take() over the pending store (the store server), async: the callback's sign-in, by its state, once and only within
   *  ten minutes of its start. The same refusal as take() when it is used, expired or unknown. */
  async takePending(state: string | null): Promise<Pending> {
    const entry = state && this.pendingStore ? await this.pendingStore.take(state) : undefined;
    if (!entry || entry.expires <= Date.now()) throw new ApiError("bad_request", `This sign-in link was used already, is older than ${STATE_MS / 60_000} minutes, or is not this server's: start the sign-in again in Settings → MCP servers.`);
    return entry;
  }

  /** The code exchanged (with the verifier and the client the start kept) for the token set to seal. */
  async finish(entry: Pending, code: string, iss: string | undefined, stop?: AbortSignal): Promise<TokenSet> {
    let tokens: OAuthTokens | undefined;
    const reach: Reach = { own: this.own, allowed: await this.allowed() };
    const provider = this.provider(entry, reach, { saved: (got) => void (tokens = got) });
    await (await sdk()).auth(provider, { serverUrl: entry.url, authorizationCode: code, ...(iss ? { iss } : {}), fetchFn: guarded(stop, entry.url, this.network, {}, reach) });
    if (!tokens || !entry.client || !entry.discovery) throw new ApiError("upstream_failed", "The authorization server gave no tokens.");
    const scope = tokens.scope ?? entry.scope;
    return { tokens: { ...tokens, ...(scope ? { scope } : {}) }, obtained_at: new Date().toISOString(), ...(expiresAt(tokens) ? { expires_at: expiresAt(tokens) } : {}), client: entry.client, kind: entry.kind, discovery: entry.discovery, ...(entry.resource ? { resource: entry.resource } : {}) };
  }

  /** A removed server's sign-in let go at its authorization server: its refresh token revoked (RFC 7009) where the
   *  metadata discovery kept names a revocation_endpoint, sent as every request of a sign-in is (guarded: its address
   *  checked, dialled at the address checked, no redirect followed), bounded as a refresh is. Best effort: whether it was
   *  accepted, never a throw. */
  async revoke(set: TokenSet, mcpUrl: string, stop?: AbortSignal): Promise<boolean> {
    const endpoint = (set.discovery?.authorizationServerMetadata as { revocation_endpoint?: unknown } | undefined)?.revocation_endpoint;
    const token = set.tokens.refresh_token;
    if (typeof endpoint !== "string" || !token) return false;
    try {
      const reach: Reach = { own: this.own, allowed: await this.allowed() };
      const { client_id: id, client_secret: secret } = set.client;
      const body = new URLSearchParams({ token, token_type_hint: "refresh_token", ...(secret ? {} : { client_id: id }) });
      // A confidential client authenticates as RFC 6749 says by default (client_secret_basic); a public one names itself.
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...(secret ? { authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}` } : {}) };
      const res = await guarded(stop, mcpUrl, this.network, {}, reach, REFRESH_REQUEST_MS)(endpoint, { method: "POST", headers, body: body.toString() });
      await res.body?.cancel().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }

  private provider(entry: Pending, reach: Reach, hooks: { state?: string; redirect?: (url: URL) => void; saved?: (tokens: OAuthTokens) => void; seen?: Seen }): OAuthClientProvider {
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
        const why = await discoveryRefusal(state, this.network, entry.url, reach);
        if (why) {
          if (hooks.seen) hooks.seen.refused ??= why;
          throw new Error(why);
        }
        entry.discovery = state;
        // A client kept from an earlier sign-in goes only to the authorization server it was registered at: another one
        // (a new address at the same origin, on a host that serves several) gets a client registered anew, never this
        // one's id or secret.
        if (entry.keptFor !== undefined) {
          if (issuerOf(state) !== entry.keptFor) {
            delete entry.client;
            entry.kind = "dynamic";
          }
          delete entry.keptFor;
        }
      },
      discoveryState: () => entry.discovery,
      saveResourceUrl: (resource) => void (entry.resource = resource),
    };
  }
}

/** `set` refreshed at its authorization server, the refresh token kept when none new is given. `reach.allowed`: the
 *  private-network hosts the owner allows (privateOAuthHosts), read by the caller for this refresh. `stop` bounds each
 *  request until it is dialled; with `sent`, a dialled request is held to `sent.within` alone (never cut short: it may
 *  have spent the refresh token), one that never left throws RequestUnsent, and `sent.seen` notes an answer's status. */
export async function refreshed(set: TokenSet, mcpUrl: string, stop?: AbortSignal, network: OAuthNetwork = systemNetwork, reach: Reach = {}, sent?: { within: AbortSignal; seen: Seen }): Promise<TokenSet> {
  const tokens = await (await sdk()).refreshAuthorization(set.discovery.authorizationServerUrl, {
    ...(set.discovery.authorizationServerMetadata ? { metadata: set.discovery.authorizationServerMetadata } : {}),
    clientInformation: set.client,
    refreshToken: set.tokens.refresh_token!,
    ...(set.resource ? { resource: set.resource } : {}),
    fetchFn: guarded(stop, mcpUrl, network, sent?.seen ?? {}, reach, REFRESH_REQUEST_MS, sent?.within),
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
