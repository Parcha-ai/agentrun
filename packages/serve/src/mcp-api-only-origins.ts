// The API-only profile's MCP origins (AGENTRUN_API_ONLY_MCP_ORIGINS, env-switch.ts) held to past the save. The server
// writes the list it started with into the store (`mcp.api_only_origins`), and removes it when it starts without the
// profile, so every reader on that store holds a per_run server the token saved to the list as it is now. The readers
// are the server's pin at an agent's save, a runner's first pin, a run's claim and each of its calls. Drop an origin and restart, and a
// server the token saved there sends nothing more: no listing, no run's mcp_auth. A server saved from the owner's
// signed-in session (which an API-only server doesn't serve) is the owner's, whenever it was saved, and the list does not
// govern it. An API-only start with the setting
// unset holds an empty list, so a per_run server the token saved with the profile off is refused until its origin is
// listed.
import { mcpSourceKey, savedByToken } from "./mcp-sources.js";
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
 *  the list a caller already read (heldApiOnlyMcpOrigins); without it, the list is read here, for a per_run row alone. */
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
