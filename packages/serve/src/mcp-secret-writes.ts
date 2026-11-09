// MCP's predicate for the one secret-write gate (SECRETS-PLAN.md, secret-writes.ts once it lands): whether an operation's
// body carries an MCP secret value, so the server's dispatch takes it from the owner's signed-in page alone and refuses
// every token. A value is a bearer token or a header's value in a saved server's auth (any auth type: a value sent is a
// value, even in a body the save then refuses), or an OAuth client_secret at a sign-in's start. The private-network
// OAuth hosts count whole: they widen where a sign-in sends its code and tokens. A server with no credential, a save that
// keeps the sealed one (prices, tools, url), a preview (it keeps nothing) and every other MCP route stay open to a token.
import { isObject } from "./validate.js";

/** Whether `operation`'s `body` writes an MCP secret (see above). */
export function mcpWritesSecret(operation: string, body: unknown): boolean {
  if (operation === "putMcpPrivateHosts") return true;
  if (!isObject(body)) return false;
  if (operation === "startMcpOAuth") return body.client_secret !== undefined;
  if (operation !== "saveMcpServer" || !isObject(body.auth)) return false;
  const { token, headers } = body.auth;
  return token !== undefined || (isObject(headers) && Object.keys(headers).length > 0);
}
