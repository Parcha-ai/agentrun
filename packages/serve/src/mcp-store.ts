// The MCP registry and OAuth sign-ins in flight, in the one store (store.mcp, store.mcpOauth), sealed with the store's one
// rule (store/seal.ts, the tl-mcp note §7): the registry row's credential under AAD mcp_servers|<name>|sealed with the url
// origin inside the plaintext, and a pending sign-in's secret parts (the PKCE verifier and the OAuth client, with its
// secret) under AAD mcp_oauth_pending|<state>|sealed. The
// store-backed replacement for mcp-servers.ts's file store and mcp-oauth.ts's in-memory pending map; the cut wires these
// into McpServers / McpSignIns, which keep their SDK tool-probe, validation and sign-in flow. The store never opens a
// credential; only this process (and a runner) does, with the seal key.
import {
  type Mcp, type McpCredential, type McpOauth, type McpServerRow, openMcpCredential, type OpenedMcpCredential,
  sealColumn, sealedAt, sealMcpCredential, unsealColumn,
} from "./store/index.js";

/** The most server-supplied text (server_info JSON, instructions) a row holds: both come from the remote server
 *  (untrusted), so they are bounded at save, never stored unbounded. */
export const MCP_META_MAX_BYTES = 16 * 1024;

/** `text` trimmed to MCP_META_MAX_BYTES on a character boundary (never a split UTF-8 char), or null when there is none. */
function boundedInstructions(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  if (Buffer.byteLength(text, "utf8") <= MCP_META_MAX_BYTES) return text;
  let out = Buffer.from(text, "utf8").subarray(0, MCP_META_MAX_BYTES).toString("utf8");
  while (Buffer.byteLength(out, "utf8") > MCP_META_MAX_BYTES) out = out.slice(0, -1);
  return out;
}

/** `info` as given when its JSON is within the cap, else null: a JSON value can't be truncated without breaking it, so an
 *  oversized one is dropped rather than stored unbounded or corrupt. */
function boundedServerInfo(info: unknown): unknown {
  if (info === null || info === undefined) return null;
  return Buffer.byteLength(JSON.stringify(info), "utf8") <= MCP_META_MAX_BYTES ? info : null;
}

/** Saves a server's registry row, its credential sealed (§7): a server with a credential (bearer, headers, or an OAuth
 *  token set) seals it under the row with the url's origin inside; one with none (auth type "none") stores null. The
 *  remote server's reported info and instructions are bounded at save (untrusted). Replaces the file the registry wrote. */
export async function saveMcpServer(
  store: { mcp: Pick<Mcp, "put"> },
  sealKey: Buffer,
  server: { name: string; url: string; auth: string; protocol?: string | null; tools: unknown; prices?: unknown; serverInfo?: unknown; instructions?: string | null; credential?: McpCredential; listedAt?: number; updatedAt?: number; credentialChangedAt?: number | null },
): Promise<McpServerRow> {
  const sealed = server.credential ? sealMcpCredential(sealKey, server.name, server.credential, server.url) : null;
  return store.mcp.put({
    name: server.name, url: server.url, auth: server.auth, protocol: server.protocol ?? null, tools: server.tools, prices: server.prices ?? null,
    serverInfo: boundedServerInfo(server.serverInfo), instructions: boundedInstructions(server.instructions), sealed,
    ...(server.listedAt !== undefined ? { listedAt: server.listedAt } : {}), ...(server.updatedAt !== undefined ? { updatedAt: server.updatedAt } : {}),
    ...(server.credentialChangedAt !== undefined ? { credentialChangedAt: server.credentialChangedAt } : {}),
  });
}

/** The server's row goes. */
export async function removeMcpServer(store: { mcp: Pick<Mcp, "remove"> }, name: string): Promise<void> {
  await store.mcp.remove(name);
}

/** Every saved server's row, by name (its credential stays sealed). */
export async function listMcpServers(store: { mcp: Pick<Mcp, "servers"> }): Promise<McpServerRow[]> {
  return store.mcp.servers();
}

/** A saved server's credential opened (§7): the credential with its origin, or why not — none saved; unopened (another
 *  seal key, or not the store's format); damaged (saved for another origin than the row's url, so it is never sent).
 *  undefined when no such server. */
export async function openServerCredential(store: { mcp: Pick<Mcp, "server"> }, sealKey: Buffer, name: string): Promise<OpenedMcpCredential | undefined> {
  const row = await store.mcp.server(name);
  return row && openMcpCredential(sealKey, { name: row.name, url: row.url, sealed: row.sealed });
}

/** Saves an MCP OAuth sign-in in flight, its secret parts sealed (§7, AAD mcp_oauth_pending|<state>|sealed): the PKCE
 *  verifier and the OAuth `client` (which carries the owner's pre-registered client_secret, and any secret a dynamic
 *  registration issued) as one sealed JSON blob the store never opens. The rest of the sign-in's working state (discovery,
 *  resource, url, was, scope, kind) is the plain `working` JSON, which holds no secret. */
export async function putPendingSignIn(
  store: { mcpOauth: Pick<McpOauth, "put"> },
  sealKey: Buffer,
  pending: { state: string; server: string; verifier: string; client?: unknown; working?: unknown; expiresAt: number },
): Promise<void> {
  const secret = JSON.stringify({ verifier: pending.verifier, ...(pending.client !== undefined ? { client: pending.client } : {}) });
  await store.mcpOauth.put({
    state: pending.state,
    server: pending.server,
    sealed: sealColumn(sealKey, sealedAt.oauthPending(pending.state), secret),
    working: pending.working ?? null,
    expiresAt: pending.expiresAt,
  });
}

/** Takes a pending sign-in at its callback, once: the store deletes and returns it in one atomic statement
 *  (store.mcpOauth.take), gone when past its expiry (with `now`), so a replay or an expired state reads as undefined and no
 *  second callback can take the same one. Its sealed verifier and client are opened here (at their own AAD), the store never
 *  opens them, and its plain working state is returned; undefined when there is none, it has expired, or the seal does not
 *  open. The one take path: nothing reads a pending sign-in any other way. */
export async function takePendingSignIn(
  store: { mcpOauth: Pick<McpOauth, "take"> },
  sealKey: Buffer,
  state: string,
  now?: number,
): Promise<{ server: string; verifier: string; client?: unknown; working: unknown; expiresAt: number } | undefined> {
  const row = await store.mcpOauth.take(state, now);
  if (!row) return undefined;
  try {
    const opened = JSON.parse(unsealColumn(sealKey, sealedAt.oauthPending(state), row.sealed).toString("utf8")) as { verifier: string; client?: unknown };
    return { server: row.server, verifier: opened.verifier, ...(opened.client !== undefined ? { client: opened.client } : {}), working: row.working, expiresAt: row.expiresAt };
  } catch {
    return undefined;
  }
}
