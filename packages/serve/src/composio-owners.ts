// The Composio users the owner connects on this install, which an API token never binds a run to. A per-run Composio
// server lends the install's Composio key to each run's binding (mcp_auth.<server> = {composio_user_id, ...}), so a
// token that could name the owner's user would run the owner's connected accounts. The set is read from the store at
// each check, never kept: a user the owner connects after a token's start is refused at the next request and at the
// run's next claim.
import { recordedMade } from "./composio-made.js";
import { COMPOSIO_LISTING_USER, COMPOSIO_USER, composioAddressUser } from "./composio-preset.js";
import { savedByToken } from "./mcp-sources.js";
import { composioAccountKey, composioMadeKey, mcpSourceKey } from "./store/mcp-record-keys.js";
import type { ComposioBinding } from "./store/seal.js";
import { isObject } from "./validate.js";

type SavedServers = { mcp: { servers(): Promise<readonly { name: string; url: string; createdAt: number }[]> }; settings: { get(key: string): Promise<unknown> } };

/** The owner's Composio users, lower-cased: always the preset's default user and its tool-listing user, and for every
 *  server the token didn't save (its source record has no token's mark, mcp-sources.ts savedByToken) the user it calls
 *  as and the user of the account its last refresh kept (composioAccountKey). A per-run server calls as none. A server
 *  with no made-record for its row (saved before those were written) names its user in its saved address, and that one
 *  is the owner's too. Read with ownersUser. */
export async function ownersComposioUsers(store: SavedServers): Promise<Set<string>> {
  const users = new Set([COMPOSIO_USER, COMPOSIO_LISTING_USER]);
  for (const row of await store.mcp.servers()) {
    if (savedByToken(await store.settings.get(mcpSourceKey(row.name)), row.createdAt)) continue;
    const made = recordedMade(await store.settings.get(composioMadeKey(row.name)), row.createdAt);
    const kept = await store.settings.get(composioAccountKey(row.name));
    const calls = made ? (made.per_run ? undefined : made.user) : composioAddressUser(row.url);
    const keptUser = isObject(kept) && kept.of === row.createdAt && typeof kept.user === "string" ? kept.user : undefined;
    for (const user of [calls, keptUser]) if (user !== undefined) users.add(user.toLowerCase());
  }
  return users;
}

/** Whether `user` is one of the owner's (ownersComposioUsers), in any letter case: a Composio user id that differs only
 *  in case is never taken as another person's. */
export const ownersUser = (owners: ReadonlySet<string>, user: string): boolean => owners.has(user.toLowerCase());

/** Whether a sealed binding may run now, given the owner's users: one the owner's session handed (`by`) always may; one
 *  the token handed, or one sealed before the mark (unknown is not the owner's), may not run as an owner's user. */
export const bindingRuns = (binding: ComposioBinding, owners: ReadonlySet<string>): boolean => binding.by === "owner" || !ownersUser(owners, binding.user_id);
