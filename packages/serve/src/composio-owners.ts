// The Composio users the owner connects on this install, which an API token never binds a run to. A per-run Composio
// server lends the install's Composio key to each run's binding (mcp_auth.<server> = {composio_user_id, ...}), so a
// token that could name the owner's user would run the owner's connected accounts. The set is read from the store at
// each check, never kept: a user the owner connects after a token's start is refused at the next request and at the
// run's next claim.
import { composioMadeKey, recordedMade } from "./composio-made.js";
import { COMPOSIO_USER } from "./composio-preset.js";
import { mcpSourceKey, savedByToken } from "./mcp-sources.js";
import type { ComposioBinding } from "./store/seal.js";

type SavedServers = { mcp: { servers(): Promise<readonly { name: string; createdAt: number }[]> }; settings: { get(key: string): Promise<unknown> } };

/** The owner's Composio users: the user each saved preset server calls as, for every server the token didn't save (its
 *  source record has no token's mark, mcp-sources.ts savedByToken) and that isn't per-run, and always the preset's
 *  default user. On an API-only server every save is the token's, so this is the default user alone. */
export async function ownersComposioUsers(store: SavedServers): Promise<Set<string>> {
  const users = new Set([COMPOSIO_USER]);
  for (const row of await store.mcp.servers()) {
    if (savedByToken(await store.settings.get(mcpSourceKey(row.name)), row.createdAt)) continue;
    const made = recordedMade(await store.settings.get(composioMadeKey(row.name)), row.createdAt);
    if (made && !made.per_run) users.add(made.user);
  }
  return users;
}

/** Whether a sealed binding may run now, given the owner's users: one the owner's session handed (`by`) always may; one
 *  the token handed, or one sealed before the mark (unknown is not the owner's), may not run as an owner's user. */
export const bindingRuns = (binding: ComposioBinding, owners: ReadonlySet<string>): boolean => binding.by === "owner" || !owners.has(binding.user_id);
