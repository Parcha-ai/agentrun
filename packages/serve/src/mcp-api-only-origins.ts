// The API-only MCP origin list (API_ONLY_MCP_ORIGINS_ENV), held in the store past the save: the serve README's API-only section.
import { composioMadeKey, composioPerRun } from "./composio-made.js";
import { COMPOSIO_TOKEN_USER_PREFIX, COMPOSIO_USER, composioTokenNamespaced } from "./composio-preset.js";
import { mcpSourceKey, savedByToken } from "./mcp-sources.js";
import { listMcpServers } from "./mcp-store.js";
import { mcpRowWorkspace } from "./mcp-workspace.js";
import { isObject } from "./validate.js";

/** The settings key the list is held under, as `{ origins: string[] }`, with `workspace_public_https: true` when the
 *  server started with WORKSPACE_MCP_PUBLIC_HTTPS_ENV on (onPublicHttpsAlone). */
export const API_ONLY_MCP_ORIGINS_KEY = "mcp.api_only_origins";

type SettingsReader = { settings: { get(key: string): Promise<unknown> } };
type SettingsWriter = { settings: { put(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> } };

/** Writes the list a server started with (`origins`, normalized) when it serves the API-only profile, and whether a
 *  workspace may save a per_run server at any public https origin (`publicHttps`); removes it otherwise. */
export async function holdApiOnlyMcpOrigins(store: SettingsWriter, apiOnly: boolean, origins: readonly string[], publicHttps = false): Promise<void> {
  if (apiOnly) await store.settings.put(API_ONLY_MCP_ORIGINS_KEY, { origins: [...origins], ...(publicHttps ? { workspace_public_https: true } : {}) });
  else await store.settings.remove(API_ONLY_MCP_ORIGINS_KEY);
}

/** The held list when the store holds the workspace public-https mode (WORKSPACE_MCP_PUBLIC_HTTPS_ENV), else undefined. */
async function heldPublicHttps(store: SettingsReader): Promise<readonly unknown[] | undefined> {
  const held = await store.settings.get(API_ONLY_MCP_ORIGINS_KEY);
  return isObject(held) && held.workspace_public_https === true && Array.isArray(held.origins) ? held.origins : undefined;
}

/** Whether a request to `url` stands on the workspace public-https mode alone: the store holds the mode and the URL's
 *  origin is not on the operator's list. Such a request is held to mcp-oauth.ts publicMcpServerAt (https, a public
 *  address, no private host the owner allows, no loopback, no cloud metadata name), at every request, whatever a save
 *  checked. A caller asks only for a workspace's server (workspaceMcpRow) or a request in a workspace. */
export async function onPublicHttpsAlone(store: SettingsReader, url: string | URL): Promise<boolean> {
  const origins = await heldPublicHttps(store);
  if (!origins) return false;
  const origin = URL.parse(String(url))?.origin ?? "";
  return !origins.includes(origin);
}

/** Whether a saved row (`name` as its reader names it) is a workspace's own: its row key, the view's `sealedAs` or the
 *  name an unscoped reader sees, is "<workspace>/<name>" (mcp-workspace.ts). */
export const workspaceMcpRow = (name: string, row: { sealedAs?: string }): boolean => mcpRowWorkspace(row.sealedAs ?? name) !== undefined;

/** The auth types a server the API token saves may have (api-only.ts apiOnlyMcpSave): per_run anywhere, headers or a
 *  bearer token in a workspace, sealed in its own row. The ones a run's claim reads the list again for before each call. */
export const TOKEN_SAVED_MCP_AUTHS: readonly string[] = ["per_run", "headers", "bearer"];

/** The list the store holds, or undefined when it holds none (a full server's store). */
export async function heldApiOnlyMcpOrigins(store: SettingsReader): Promise<readonly unknown[] | undefined> {
  const held = await store.settings.get(API_ONLY_MCP_ORIGINS_KEY);
  return isObject(held) && Array.isArray(held.origins) ? held.origins : undefined;
}

/** Why the saved server `name` (`row`) can't be used, or undefined when it can. It can't be used when it is a per_run
 *  server the API token saved, or one that seals a credential the token saved (a workspace's own, mcp-secret-writes.ts
 *  workspaceWriteRefused), the store holds an API-only list, and its address's origin is not on that list, unless it is
 *  a workspace's per_run server at an https address and the store holds the workspace public-https mode (each of its
 *  requests then held to publicMcpServerAt). `held`: the list a caller already read (heldApiOnlyMcpOrigins); without it,
 *  the list is read here, for such a row alone. Undefined means "not read", never "none held": a caller passes the list
 *  only when the store holds one. */
export async function offApiOnlyMcpOrigins(store: SettingsReader, name: string, row: { auth: string; url: string; sealed?: unknown; createdAt?: number; sealedAs?: string }, held?: readonly unknown[]): Promise<string | undefined> {
  if (row.auth !== "per_run" && (row.sealed === null || row.sealed === undefined)) return undefined;
  const origins = held ?? (await heldApiOnlyMcpOrigins(store));
  if (!origins) return undefined;
  if (!savedByToken(await store.settings.get(mcpSourceKey(name)), row.createdAt)) return undefined;
  let origin: string;
  try {
    origin = new URL(row.url).origin;
  } catch {
    origin = "";
  }
  if (origins.includes(origin)) return undefined;
  if (row.auth === "per_run" && (row.sealed === null || row.sealed === undefined) && origin.startsWith("https://") && workspaceMcpRow(name, row) && (await heldPublicHttps(store))) return undefined;
  return offApiOnlyMcpOriginsWords(name);
}

/** The words a per_run server the token saved at an origin off the list is refused with (offApiOnlyMcpOrigins). */
export const offApiOnlyMcpOriginsWords = (name: string): string =>
  `The MCP server ${name} can't be used: the API token saved it at an origin that is no longer on this server's AGENTRUN_API_ONLY_MCP_ORIGINS. Nothing was sent.`;

/** The names of the saved servers offApiOnlyMcpOrigins refuses now, sorted: none when the store holds no list. What an
 *  API-only start says once in its log (server.ts), by name alone, never an address: on an upgrade with the setting
 *  unset, the only notice before a run that grants one fails. */
export async function offApiOnlyMcpServers(store: SettingsReader & Parameters<typeof listMcpServers>[0]): Promise<string[]> {
  const held = await heldApiOnlyMcpOrigins(store);
  if (!held) return [];
  const off: string[] = [];
  for (const row of await listMcpServers(store)) if (await offApiOnlyMcpOrigins(store, row.name, row, held)) off.push(row.name);
  return off.sort();
}

/** Why the Composio server `name` (`row`) the API token saved can't be used on an API-only store, or undefined when it
 *  can: one calling as a single user (not per-run) whose address names a user outside the token's namespace
 *  (composioTokenNamespaced), as a save before the namespace (0.1.0-beta.56 and earlier) left it, which may be the
 *  owner's. Its claim is refused unsent, in words that say to delete it, since a re-save of it is refused where the
 *  owner's server stands on its auth config. A server the owner saved, or any on a full server's store, is as it was. */
export async function composioOutsideNamespace(store: SettingsReader, name: string, row: { auth: string; url: string; createdAt: number }, held?: readonly unknown[]): Promise<string | undefined> {
  if (row.auth !== "headers") return undefined;
  if (!(held ?? (await heldApiOnlyMcpOrigins(store)))) return undefined;
  const source = await store.settings.get(mcpSourceKey(name));
  if (!savedByToken(source, row.createdAt) || !isObject(source) || source.source !== "composio") return undefined;
  if (composioPerRun(row, await store.settings.get(composioMadeKey(name)))) return undefined;
  let user: string;
  try {
    user = new URL(row.url).searchParams.get("user_id") ?? COMPOSIO_USER;
  } catch {
    user = "";
  }
  return composioTokenNamespaced(user) ? undefined : composioOutsideNamespaceWords(name);
}

/** The words a Composio server the token saved before the namespace is refused with (composioOutsideNamespace). */
export const composioOutsideNamespaceWords = (name: string): string =>
  `The MCP server ${name} can't be used: the API token saved it before its Composio users were kept in the token's namespace (${COMPOSIO_TOKEN_USER_PREFIX}), so it calls as a user that may be the owner's. Delete it, then save it again. Nothing was sent.`;

/** The names of the saved servers composioOutsideNamespace refuses now, sorted: none on a full server's store. What an
 *  API-only start says once in its log, by name alone, never a user or an address. */
export async function composioOutsideNamespaceServers(store: SettingsReader & Parameters<typeof listMcpServers>[0]): Promise<string[]> {
  const held = await heldApiOnlyMcpOrigins(store);
  if (!held) return [];
  const out: string[] = [];
  for (const row of await listMcpServers(store)) if (await composioOutsideNamespace(store, row.name, row, held)) out.push(row.name);
  return out.sort();
}
