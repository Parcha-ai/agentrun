// The MCP registry and OAuth sign-ins in flight, in the one store (store.mcp, store.mcpOauth), sealed with the store's one
// rule (store/seal.ts, the tl-mcp note §7): the registry row's credential under AAD mcp_servers|<name>|sealed with the url
// origin inside the plaintext, and a pending sign-in's PKCE verifier under AAD mcp_oauth_pending|<state>|verifier. The
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
  server: { name: string; url: string; auth: string; protocol?: string | null; tools: unknown; prices?: unknown; serverInfo?: unknown; instructions?: string | null; credential?: McpCredential },
): Promise<McpServerRow> {
  const sealed = server.credential ? sealMcpCredential(sealKey, server.name, server.credential, server.url) : null;
  return store.mcp.put({ name: server.name, url: server.url, auth: server.auth, protocol: server.protocol ?? null, tools: server.tools, prices: server.prices ?? null, serverInfo: boundedServerInfo(server.serverInfo), instructions: boundedInstructions(server.instructions), sealed });
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

/** Saves an MCP OAuth sign-in in flight, its PKCE verifier sealed (§7, AAD mcp_oauth_pending|<state>|verifier). The rest of
 *  the sign-in's working state (the client, discovery and resource the callback needs) is NOT persisted here — the schema
 *  seals only the verifier; how those survive to the callback is tl-mcp's to settle before McpSignIns is wired. */
export async function putPendingSignIn(
  store: { mcpOauth: Pick<McpOauth, "put"> },
  sealKey: Buffer,
  pending: { state: string; server: string; verifier: string; cookieBinding: string; working?: unknown; expiresAt: number },
): Promise<void> {
  await store.mcpOauth.put({
    state: pending.state,
    server: pending.server,
    verifierSealed: sealColumn(sealKey, sealedAt.oauthVerifier(pending.state), pending.verifier),
    cookieBinding: pending.cookieBinding,
    working: pending.working ?? null,
    expiresAt: pending.expiresAt,
  });
}

/** Takes a pending sign-in at its callback, once: the store deletes and returns it in one atomic statement
 *  (store.mcpOauth.take), gone when past its expiry (with `now`), so a replay or an expired state reads as undefined and no
 *  second callback can take the same one. Its verifier is opened here (at its own AAD), the store never opens it, and its
 *  plain working state is returned; undefined when there is none, it has expired, or the verifier does not open. The old
 *  get()+remove() split is gone: nothing takes a sign-in any other way. */
export async function takePendingSignIn(
  store: { mcpOauth: Pick<McpOauth, "take"> },
  sealKey: Buffer,
  state: string,
  now?: number,
): Promise<{ server: string; verifier: string; cookieBinding: string; working: unknown; expiresAt: number } | undefined> {
  const row = await store.mcpOauth.take(state, now);
  if (!row) return undefined;
  try {
    return { server: row.server, verifier: unsealColumn(sealKey, sealedAt.oauthVerifier(state), row.verifierSealed).toString("utf8"), cookieBinding: row.cookieBinding, working: row.working, expiresAt: row.expiresAt };
  } catch {
    return undefined;
  }
}
