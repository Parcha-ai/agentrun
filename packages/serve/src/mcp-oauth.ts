// OAuth sign-in to a remote MCP server, run by this server with the official SDK's `auth` (@modelcontextprotocol/client):
// RFC 9728 then RFC 8414 discovery, the client (the owner's pre-registered one; else this server's client metadata
// document, only when its address is public https; else dynamic registration), PKCE S256, the RFC 8707 resource, the
// code exchange and the refresh. What is here is only what the SDK's provider keeps: a sign-in in progress, in memory by
// its state (random, used once, ten minutes), and the token set the callback hands mcp-servers.ts to seal. No token is
// ever answered, logged or handed to the browser.
import { randomBytes } from "node:crypto";
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

export type ClientKind = "pre-registered" | "metadata-document" | "dynamic";
/** What is sealed: the tokens and all a refresh needs. */
export type TokenSet = { tokens: OAuthTokens; obtained_at: string; expires_at?: string; client: StoredOAuthClientInformation; kind: ClientKind; discovery: OAuthDiscoveryState; resource?: string };
type Pending = { name: string; url: string; was: string | null; scope?: string; kind: ClientKind; client?: StoredOAuthClientInformation; verifier?: string; discovery?: OAuthDiscoveryState; resource?: string; expires: number };

const sdk = () => import("@modelcontextprotocol/client");
/** The authorization server's requests: no redirect followed (a code or secret goes only where discovery said), each
 *  held to REQUEST_MS. */
const guarded = (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(REQUEST_MS), ...(init?.signal ? [init.signal] : [])]) });
const expiresAt = (tokens: OAuthTokens) => (tokens.expires_in !== undefined ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined);
const LOOPBACK = /^(?:localhost|\[::1\]|127(?:[.]\d{1,3}){3})$/; // key-gate: loopback-rule CIMD is never offered from a loopback address

export class McpSignIns {
  private readonly pending = new Map<string, Pending>();
  /** This server's address as a browser reaches it (AGENTRUN_PUBLIC_URL, else where it listens), no trailing slash:
   *  set by McpServers.attach as the server starts listening. */
  base = "";

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
    const provider = this.provider(entry, { state, redirect: (to) => void (opened = to) });
    try {
      await (await sdk()).auth(provider, { serverUrl: url, ...(options.scope ? { scope: options.scope } : {}), fetchFn: guarded });
    } catch (error) {
      throw new ApiError("upstream_failed", `The sign-in to ${url.origin} did not start: ${(error as Error).message.slice(0, 300)}`);
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
  async finish(entry: Pending, code: string, iss: string | undefined): Promise<TokenSet> {
    let tokens: OAuthTokens | undefined;
    const provider = this.provider(entry, { saved: (got) => void (tokens = got) });
    await (await sdk()).auth(provider, { serverUrl: entry.url, authorizationCode: code, ...(iss ? { iss } : {}), fetchFn: guarded });
    if (!tokens || !entry.client || !entry.discovery) throw new ApiError("upstream_failed", "The authorization server gave no tokens.");
    const scope = tokens.scope ?? entry.scope;
    return { tokens: { ...tokens, ...(scope ? { scope } : {}) }, obtained_at: new Date().toISOString(), ...(expiresAt(tokens) ? { expires_at: expiresAt(tokens) } : {}), client: entry.client, kind: entry.kind, discovery: entry.discovery, ...(entry.resource ? { resource: entry.resource } : {}) };
  }

  private provider(entry: Pending, hooks: { state?: string; redirect?: (url: URL) => void; saved?: (tokens: OAuthTokens) => void }): OAuthClientProvider {
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
      saveDiscoveryState: (state) => void (entry.discovery = state),
      discoveryState: () => entry.discovery,
      saveResourceUrl: (resource) => void (entry.resource = resource),
    };
  }
}

/** `set` refreshed at its authorization server, the refresh token kept when none new is given. */
export async function refreshed(set: TokenSet): Promise<TokenSet> {
  const tokens = await (await sdk()).refreshAuthorization(set.discovery.authorizationServerUrl, {
    ...(set.discovery.authorizationServerMetadata ? { metadata: set.discovery.authorizationServerMetadata } : {}),
    clientInformation: set.client,
    refreshToken: set.tokens.refresh_token!,
    ...(set.resource ? { resource: set.resource } : {}),
    fetchFn: guarded,
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
