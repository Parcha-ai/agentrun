// The API-only MCP origin list (API_ONLY_MCP_ORIGINS_ENV), held in the store past the save: the serve README's API-only section.
import { mcpSourceKey, savedByToken } from "./mcp-sources.js";
import { listMcpServers } from "./mcp-store.js";
import { isObject } from "./validate.js";

/** The settings key the list is held under, as `{ origins: string[] }`. */
export const API_ONLY_MCP_ORIGINS_KEY = "mcp.api_only_origins";

type SettingsReader = { settings: { get(key: string): Promise<unknown> } };
type SettingsWriter = { settings: { put(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> } };

/** Writes the list a server started with (`origins`, normalized) when it serves the API-only profile; removes it
 *  otherwise. */
export async function holdApiOnlyMcpOrigins(store: SettingsWriter, apiOnly: boolean, origins: readonly string[]): Promise<void> {
  if (apiOnly) await store.settings.put(API_ONLY_MCP_ORIGINS_KEY, { origins: [...origins] });
  else await store.settings.remove(API_ONLY_MCP_ORIGINS_KEY);
}

/** The list the store holds, or undefined when it holds none (a full server's store). */
export async function heldApiOnlyMcpOrigins(store: SettingsReader): Promise<readonly unknown[] | undefined> {
  const held = await store.settings.get(API_ONLY_MCP_ORIGINS_KEY);
  return isObject(held) && Array.isArray(held.origins) ? held.origins : undefined;
}

/** Why the saved server `name` (`row`) can't be used, or undefined when it can. It can't be used when it is a per_run
 *  server the API token saved, the store holds an API-only list, and its address's origin is not on that list. `held`:
 *  the list a caller already read (heldApiOnlyMcpOrigins); without it, the list is read here, for a per_run row alone.
 *  Undefined means "not read", never "none held": a caller passes the list only when the store holds one. */
export async function offApiOnlyMcpOrigins(store: SettingsReader, name: string, row: { auth: string; url: string; createdAt?: number }, held?: readonly unknown[]): Promise<string | undefined> {
  if (row.auth !== "per_run") return undefined;
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
