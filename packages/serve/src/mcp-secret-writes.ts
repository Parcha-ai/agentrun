// MCP's predicates for the one secret-write gate (secret-writes.ts): which MCP operations the server's dispatch takes from
// the owner's signed-in page alone, refusing every token.
// - A save that sends a value (a bearer token or a header's value, in any auth type: a value sent is a value, even in a
//   body the save then refuses) writes a secret.
// - A sign-in's start always writes one: its callback seals whatever token set the sign-in it started returns, so who
//   starts it decides whose credential the server's runs use.
// - The private-network OAuth hosts count whole, since they widen where a sign-in sends its code and tokens.
// - The token saves over and removes only a server the token saved that seals no credential (tokenWriteOverRefused: one
//   rule for every such route, read from the store): the owner's stays the owner's, sealed or not, so the token never
//   drops or changes its credential, moves it, or removes what it made at Composio.
// A new server with no credential, the token's own server, a preview and a refresh (each keeps nothing new) stay open to a
// token.
// - In a workspace (API-only), a save or removal is judged on the workspace's own row alone (workspaceWriteRefused): its
//   token writes its own server's credential, which no other workspace and no owner reaches.
import { composioMadeKey, recordedMade } from "./composio-made.js";
import { COMPOSIO_TOOLKIT } from "./composio-preset.js";
import type { InputIssue } from "./errors.js";
import { secretShapes } from "./learn/secrets.js";
import { urlOf } from "./mcp-probe.js";
import { mcpSourceKey, savedByToken } from "./mcp-sources.js";
import { registerNotSecretWrite, registerSecretPage, registerSecretWrite, registerWorkspaceSecretWrite, type SecretRequest } from "./secret-writes.js";
import type { McpCredentialMark } from "./store/index.js";
import { MCP_SERVER_NAME } from "./tool-names.js";
import { isObject } from "./validate.js";

/** Whether `operation`'s `body` writes an MCP secret by the body alone (see above). */
export function mcpWritesSecret(operation: string, body: unknown): boolean {
  if (operation === "putMcpPrivateHosts" || operation === "startMcpOAuth") return true;
  if (operation !== "saveMcpServer" || !isObject(body) || !isObject(body.auth)) return false;
  // A per_run server keeps no credential: headers sent with its save only list its tools, as a preview's do. The
  // credentials it later receives are the ones each run's own caller hands it (mcp_auth).
  if (body.auth.type === "per_run") return false;
  const { token, headers } = body.auth;
  return token !== undefined || (isObject(headers) && Object.keys(headers).length > 0);
}

/** The least of a saved server's row a save's check reads: its auth type, its sealed credential and when that was set,
 *  and when the row was made (its source record is bound to it). */
type SavedRow = { auth: string; sealed: unknown; credentialChangedAt?: number | null; createdAt?: number };
type SavedServers = { mcp: { server(name: string): Promise<SavedRow | undefined>; servers(): Promise<(SavedRow & { name: string })[]> }; settings: { get(key: string): Promise<unknown> } };

/** The saved server the owner saved (no token's mark on its record, mcp-sources.ts savedByToken) that stands on the
 *  Composio auth config `id` (its record of what it stands on there, composio-made.ts), by name; undefined when none
 *  does. The API token's Composio save never stands on one: a server made against it acts as the owner's connected
 *  account for that user (the preset's default user is the owner's too), and once the owner's server is deleted, the
 *  token's record would be handed what the owner's made, and its delete would remove that at Composio. */
export async function ownersAuthConfig(store: SavedServers, id: string): Promise<string | undefined> {
  for (const row of await store.mcp.servers()) {
    if (recordedMade(await store.settings.get(composioMadeKey(row.name)), row.createdAt)?.auth_config?.id !== id) continue;
    if (!savedByToken(await store.settings.get(mcpSourceKey(row.name)), row.createdAt)) return row.name;
  }
  return undefined;
}

/** Whether a server the API token saved holds the Composio connected account `id` as made here (its record of what it
 *  stands on there): the one account, besides those its own connect links start, that the token's Composio save may
 *  stand on. One recorded as found (made: false) is not the token's: a save before this rule could record the owner's. */
export async function tokensAccount(store: SavedServers, id: string): Promise<boolean> {
  for (const row of await store.mcp.servers()) {
    if (!recordedMade(await store.settings.get(composioMadeKey(row.name)), row.createdAt)?.accounts.some((account) => account.id === id && account.made)) continue;
    if (savedByToken(await store.settings.get(mcpSourceKey(row.name)), row.createdAt)) return true;
  }
  return false;
}

/** A saved server's credential as a writer read it (McpCredentialMark): its auth type, whether one is sealed, and when it
 *  was set. A save let through against one mark writes only while the row still has it, in the store's one statement
 *  (Mcp.putIfCredential), so it never lands over a credential saved or signed in with after the check. */
export const credentialMark = (row: SavedRow | undefined): McpCredentialMark => (row ? { auth: row.auth, sealed: row.sealed !== null && row.sealed !== undefined, changedAt: row.credentialChangedAt ?? null } : null);

/** The one rule for the token's write over the saved server its path names, whatever the route: a save over it (the
 *  generic save, a Composio save) or its removal. Refused unless the token saved that very row (its source record's mark,
 *  mcp-sources.ts savedByToken) and it seals no credential: an owner's server stays the owner's, sealed or not, so the
 *  token never drops or changes its credential, moves it, or removes what it made at Composio. A new name has nothing to
 *  write over. The write lands only while the row's credential is still the one read here (request.seen) and the row
 *  still carries the token's mark, both compared in the store's statement that writes or removes it (McpServers save and
 *  remove), so an owner's save landing after this check is never written over or removed. */
export async function tokenWriteOverRefused(_body: unknown, request: SecretRequest): Promise<boolean> {
  const [name] = request.params;
  if (!name) return false;
  const store = request.store as SavedServers;
  const was = await store.mcp.server(name);
  request.seen = credentialMark(was);
  if (!was) return false;
  return (was.sealed !== null && was.sealed !== undefined) || !savedByToken(await store.settings.get(mcpSourceKey(name)), was.createdAt);
}

/** A workspace's token's save or removal of its own server (API-only, mcp-workspace.ts): refused only over a row of the
 *  name its token did not save. A workspace's server is its own row, its credential sealed at its row key (bound to the
 *  workspace, so it opens in no other row) and handed only to its own agents' runs, and no other workspace and no owner
 *  reaches it, so its token saves, replaces and removes its credential. The write lands only while the row's credential
 *  is still the one read here (request.seen), as every token write's does. What address a save may name is the save's
 *  own check (api-only.ts apiOnlyMcpSave). */
export async function workspaceWriteRefused(_body: unknown, request: SecretRequest): Promise<boolean> {
  const [name] = request.params;
  if (!name) return false;
  const store = request.store as SavedServers;
  const was = await store.mcp.server(name);
  request.seen = credentialMark(was);
  if (!was) return false;
  return !savedByToken(await store.settings.get(mcpSourceKey(name)), was.createdAt);
}

/** MCP's operations the one gate reads: the predicates above decide each request. */
export const MCP_SECRET_OPERATIONS = ["saveMcpServer", "startMcpOAuth", "putMcpPrivateHosts", "deleteMcpServer"] as const;
const STORED: Partial<Record<(typeof MCP_SECRET_OPERATIONS)[number], (body: unknown, request: SecretRequest) => Promise<boolean>>> = { saveMcpServer: tokenWriteOverRefused, deleteMcpServer: tokenWriteOverRefused };
for (const operation of MCP_SECRET_OPERATIONS) registerSecretWrite(operation, (body) => mcpWritesSecret(operation, body), STORED[operation]);
registerWorkspaceSecretWrite("saveMcpServer", workspaceWriteRefused);
registerWorkspaceSecretWrite("deleteMcpServer", workspaceWriteRefused);
// The Composio preset takes the owner's API key and seals it as an MCP header: its routes are the owner's session alone,
// whatever the body (the listings, of a toolkit's actions and of the toolkits, send the key too, and only the session may
// type one).
registerSecretWrite("listComposioTools", () => true);
registerSecretWrite("listComposioToolkits", () => true);
registerSecretWrite("saveComposioServer", composioSaveSendsKey, composioSaveDropsSecret);
// A save's body that sends a key's value, or anything but api_key_env alone in its place: a secret written.
function composioSaveSendsKey(body: unknown): boolean {
  return !(isObject(body) && body.api_key === undefined && body.api_key_env !== undefined);
}
/** A Composio save that names its key by api_key_env (the server keeps the variable's name, never its value) writes no
 *  secret only on an API-only server, which has no owner to save the key from the console: its token's own save, over a
 *  new name or a server the token saved, by the one rule (tokenWriteOverRefused). What it stands on at Composio is the
 *  save's own check (McpServersOverStore.tokenStandsOn and tokenAccountOn). Anywhere else the owner saves keys from the
 *  console, so the token's is the one refusal as before. */
export async function composioSaveDropsSecret(body: unknown, request: SecretRequest): Promise<boolean> {
  if (!request.apiOnly || !request.params[0]) return true;
  return tokenWriteOverRefused(body, request);
}
// A Composio server's webhook subscription (composio-triggers.ts): a rotate seals its new secret, a delete drops it.
registerSecretWrite("rotateComposioSecret", () => true);
registerSecretWrite("deleteComposioSubscription", () => true);
registerNotSecretWrite("refreshMcpServer", "A refresh lists the saved server's tools again with its sealed credential, and writes no credential.");
registerNotSecretWrite("previewMcpServer", "A preview lists a server's tools and keeps nothing.");

// ---- where a refused MCP secret write is finished ---------------------------------------------------------------------
//
// The console's Settings → MCP servers (`/#/settings/mcp`). A save or a sign-in's start opens its form filled with what
// the request held that is no secret (the console reads these: apps/console src/lib/mcp.ts addOf): `add=<name>` for a new
// server, `change=<name>` for a saved one (its Change form, so the save lands on it and never on a `<name>-2`); `url`,
// only when nothing in it could be a credential (linkableUrl); `auth`, the kind of credential (never one); `toolkit`.
// A Composio save or listing opens the Composio form with its toolkit and the actions to tick. Never a token, a header's
// name or value, a client id or secret, a Composio key.

/** A path segment, query name or value, or name shaped like a key: 20 or more characters of a token's alphabet, with a
 *  digit or both cases of letter in it (a Zapier-style /mcp/<key>/sse, a UUID, base64). A plain word or a dashed name
 *  ("streamable-http-endpoint") is none. */
const keyShaped = (part: string): boolean => /^[A-Za-z0-9_\-+/=.~%]{20,}$/.test(part) && (/\d/.test(part) || (/[a-z]/.test(part) && /[A-Z]/.test(part)));
/** Whether `text` holds a key that spans separators: base64's alphabet has "/" and "+", so one key can cross path segments
 *  (`aB3dE5gH7jK9mN2p/Q4rS6tU8vW0xY2z4`, each piece too short to look like one) or read as two words once a query's "+"
 *  is decoded. Any run of 20 or more base64 characters, separators counted, with both cases of letter in it. A path of
 *  plain lowercase words and digits ("/mcp/v1/sse/stream/events") is none. */
const spansKey = (text: string): boolean => (text.match(/[A-Za-z0-9+/=]{20,}/g) ?? []).some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run));
/** Whether a host's label could be an unguessable id (a per-person subdomain): 20 or more letters and digits in a row with
 *  a digit in them, or a UUID. */
const hostKeyed = (label: string): boolean => (label.match(/[a-z0-9]{20,}/g) ?? []).some((run) => /\d/.test(run)) || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(label);
const decoded = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** The URL a refusal's console link may carry: only one a save would take as it is (http or https, at most 2048
 *  characters, no user or password, no query parameter named like a credential: urlOf, the save's own check), with
 *  nothing in it shaped like a secret (secretShapes, the learning guard's shapes), no key-shaped path segment or query
 *  name or value, no key spanning path segments or a query's separators (spansKey), and no host label that could be an id.
 *  Its fragment is dropped. Anything else is left out whole, and the person pastes it in the console. */
export function linkableUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const issues: InputIssue[] = [];
  const url = urlOf(value, issues);
  if (!url || issues.length || secretShapes(value).length || secretShapes(decoded(value)).length) return undefined;
  const parts = [...url.pathname.split("/"), ...[...url.searchParams].flat()];
  if (parts.some((part) => keyShaped(part) || keyShaped(decoded(part)) || keyShaped(part.replace(/\s+/g, "")))) return undefined;
  if ([url.pathname, decoded(url.pathname), url.search, decoded(url.search)].some(spansKey)) return undefined;
  return url.hostname.split(".").some(hostKeyed) ? undefined : url.href;
}

/** A server's name or a toolkit as a link may carry it: a name a server can have, and not key-shaped. */
const linkName = (value: unknown): string | undefined => (typeof value === "string" && MCP_SERVER_NAME.test(value) && !keyShaped(value) ? value : undefined);
/** The kinds of credential the console's form can fill. `per_run` (and anything else) it cannot: such a save's link opens
 *  the page alone, since a form filled otherwise would save another kind than the one asked for. */
const AUTH_TYPES: ReadonlySet<string> = new Set(["none", "bearer", "headers", "oauth", "github_app"]);
const MCP_PAGE = "/#/settings/mcp";

/** `operation`'s console page, built from the request (see above). */
export const mcpSecretPage = (operation: string) => async (body: unknown, request: SecretRequest): Promise<string> => {
  const given = isObject(body) ? body : {};
  const toolkit = linkName(given.toolkit);
  const servers = (request.store as SavedServers).mcp;
  if (operation === "listComposioTools" || operation === "saveComposioServer") {
    // The toolkit as the preset takes it (composio-preset.ts: trimmed, lower-cased, Composio's slug rule, which allows
    // "_" and 64 characters); a listing names no server, so its link's name is that toolkit as a server's name can be.
    const slug = typeof given.toolkit === "string" ? given.toolkit.trim().toLowerCase() : "";
    const composio = COMPOSIO_TOOLKIT.test(slug) && !keyShaped(slug) ? slug : undefined;
    const name = linkName(operation === "saveComposioServer" ? request.params[0] : composio?.replace(/_/g, "-").slice(0, 32));
    if (!name || !composio) return MCP_PAGE;
    // A save over a saved server's name replaces that server: `change`, so the console saves under the name asked for and
    // never moves it to a free `<name>-2` beside the old one. A listing names no server, so it is always a new one's.
    const replaces = operation === "saveComposioServer" && (await servers.server(name)) !== undefined;
    const query = new URLSearchParams({ [replaces ? "change" : "add"]: name, preset: "composio", toolkit: composio });
    const tools = Array.isArray(given.tools) ? given.tools.filter((tool): tool is string => typeof tool === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(tool) && !keyShaped(tool)).slice(0, 64) : [];
    if (tools.length) query.set("tools", tools.join(","));
    return `${MCP_PAGE}?${query}`;
  }
  if (operation !== "saveMcpServer" && operation !== "startMcpOAuth") return MCP_PAGE;
  const name = linkName(request.params[0]);
  if (!name) return MCP_PAGE;
  // The kind of credential the request asks for. A save with no auth asks for none (mcp-probe authOf), which the link says
  // so a Change form never falls back to the saved kind and keeps the credential the save would have dropped.
  const asked = operation === "startMcpOAuth" ? "oauth" : given.auth === undefined ? "none" : isObject(given.auth) ? given.auth.type : undefined;
  if (typeof asked !== "string" || !AUTH_TYPES.has(asked)) return MCP_PAGE;
  const saved = await servers.server(name);
  const query = new URLSearchParams({ [saved ? "change" : "add"]: name });
  const url = linkableUrl(given.url);
  if (url) query.set("url", url);
  query.set("auth", asked);
  if (toolkit) query.set("toolkit", toolkit);
  return `${MCP_PAGE}?${query}`;
};

for (const operation of ["saveMcpServer", "startMcpOAuth", "listComposioTools", "saveComposioServer"]) registerSecretPage(operation, mcpSecretPage(operation));
registerSecretPage(["putMcpPrivateHosts", "deleteMcpServer", "rotateComposioSecret", "deleteComposioSubscription", "listComposioToolkits"], MCP_PAGE);
