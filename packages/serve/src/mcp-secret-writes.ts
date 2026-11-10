// MCP's predicates for the one secret-write gate (secret-writes.ts): which MCP operations the server's dispatch takes from
// the owner's signed-in page alone, refusing every token.
// - A save that sends a value (a bearer token or a header's value, in any auth type: a value sent is a value, even in a
//   body the save then refuses) writes a secret; so does one that would DROP or CHANGE the credential a saved server
//   holds (another auth type, or none), read from the store.
// - A sign-in's start always writes one: its callback seals whatever token set the sign-in it started returns, so who
//   starts it decides whose credential the server's runs use.
// - Removing a server drops its credential; the private-network OAuth hosts count whole, since they widen where a sign-in
//   sends its code and tokens.
// A server with no credential, a save that keeps the sealed one (prices, tools, url), a preview and a refresh (each keeps
// nothing new) stay open to a token.
import { registerNotSecretWrite, registerSecretWrite, type SecretRequest } from "./secret-writes.js";
import { isObject } from "./validate.js";

/** Whether `operation`'s `body` writes an MCP secret by the body alone (see above). */
export function mcpWritesSecret(operation: string, body: unknown): boolean {
  if (operation === "putMcpPrivateHosts" || operation === "startMcpOAuth" || operation === "deleteMcpServer") return true;
  if (operation !== "saveMcpServer" || !isObject(body) || !isObject(body.auth)) return false;
  const { token, headers } = body.auth;
  return token !== undefined || (isObject(headers) && Object.keys(headers).length > 0);
}

/** The least of a saved server's row a save's check reads: its auth type, its sealed credential and when that was set. */
type SavedRow = { auth: string; sealed: unknown; credentialChangedAt?: number | null };
type SavedServers = { mcp: { server(name: string): Promise<SavedRow | undefined> } };

/** A saved server's credential as a save's check saw it: its auth type, whether one is sealed, and when it was set (a
 *  token refresh keeps that time; a new credential or a sign-in moves it). A save allowed against one mark is refused
 *  when the row's mark differs by the time it writes (mcp-servers-store.ts save). */
export const credentialMark = (row: SavedRow | undefined): string => (row ? JSON.stringify([row.auth, row.sealed !== null && row.sealed !== undefined, row.credentialChangedAt ?? null]) : "absent");

/** Whether a save of the server its path names (with no value in its body) would drop or change the credential the
 *  server holds: it holds one, and the save names another auth type, or none (a body with no auth is none). */
export async function mcpSaveDropsSecret(body: unknown, request: SecretRequest): Promise<boolean> {
  const [name] = request.params;
  if (!name) return false;
  const was = await (request.store as SavedServers).mcp.server(name);
  // What the save is let through against: it lands only if the credential is still this one.
  request.seen = credentialMark(was);
  if (!was || was.sealed === null || was.sealed === undefined) return false;
  const auth = isObject(body) ? body.auth : undefined;
  const type = auth === undefined ? "none" : isObject(auth) ? auth.type : undefined;
  return type !== was.auth;
}

/** MCP's operations the one gate reads: the predicates above decide each request. */
export const MCP_SECRET_OPERATIONS = ["saveMcpServer", "startMcpOAuth", "putMcpPrivateHosts", "deleteMcpServer"] as const;
for (const operation of MCP_SECRET_OPERATIONS) {
  registerSecretWrite(operation, (body) => mcpWritesSecret(operation, body), operation === "saveMcpServer" ? mcpSaveDropsSecret : undefined);
}
// A preview keeps nothing, so it is never a secret write; its body's fields are marked secret in the document, so it is
// registered all the same.
registerSecretWrite("previewMcpServer", () => false);
registerNotSecretWrite("refreshMcpServer", "A refresh lists the saved server's tools again with its sealed credential, and writes no credential.");
