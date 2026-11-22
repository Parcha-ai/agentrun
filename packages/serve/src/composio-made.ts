// What the Composio preset made on Composio for a saved server beyond its MCP server (whose id the server's address
// names): the auth config it found or made, and the connected accounts it found ACTIVE or its connect links started,
// each marked whether this server made it (`made`). Recorded when the preset saves the server, one row of store.settings
// per server (composioMadeKey), bound to the server row it was written for (`of`, the row's created_at, which a save over
// the row keeps) as its source record is (mcp-sources.ts); read when the server is deleted. The delete removes what was
// made that no other saved server uses (cleanupOf), and passes what another one uses to that one's record, so the last
// of them to go removes it. What this server didn't make (an auth config or an account the owner had already, or one no
// record says it made, as for a server saved before this was recorded) is never removed. A save over the server does the
// same with what the record it replaces made that the new one no longer stands on (droppedOf). An auth config the owner
// names in a save (auth_config_id) is the owner's from that save on, whoever made it: the record written says it was not
// made here, and every other record's claim to have made it is let go (releasedOf), so no delete or save removes it.
import { isObject } from "./validate.js";

/** A thing on Composio by its id, and whether this server made it. */
export type Made = { id: string; made: boolean };
/** What a preset server stands on at Composio: the user its address names, its auth config (none for a toolkit with no
 *  sign-in; `named`, from a save, when the owner named it: theirs, never recorded as made) and the connected accounts
 *  under it. `per_run`: saved with `user_id: "per_run"` (COMPOSIO_PER_RUN), its address names no user and no account,
 *  and each run names its own (mcp_auth, composioPerRun); `user` is then that word and `accounts` empty. Only a save made
 *  since the mode exists writes it, so a server saved before for a Composio user literally named "per_run" keeps that
 *  user until it is saved again. `key_env`: saved with `api_key_env`, its key is read from this variable of the server's
 *  environment at each use, and its row seals no credential (composioKeyFromEnv). */
export type ComposioMade = { user: string; auth_config: (Made & { named?: true }) | null; accounts: Made[]; per_run?: true; key_env?: typeof COMPOSIO_KEY_ENV };

/** The one variable a Composio save may name for its key (`api_key_env`). Composio's host is fixed in code, so no other
 *  secret of the server's environment is ever sent there. */
export const COMPOSIO_KEY_ENV = "COMPOSIO_API_KEY";
/** Composio's origin: its API's base (composio-preset.ts) and where its MCP servers are (a preset save's address). The one
 *  place a key read from the environment is ever sent. */
export const COMPOSIO_ORIGIN = "https://backend.composio.dev";
/** What a delete does at Composio beyond the MCP server: what it removes, in order (the accounts before the auth config
 *  they are under), and what it keeps, each with whose it stays (`by`: the saved server that uses it too; none: this
 *  server didn't make it). */
export type Cleanup = { remove: Thing[]; kept: (Thing & { by?: string })[] };
export type Thing = { kind: "account" | "auth_config"; id: string };

/** The store.settings key a server's record lives under. */
export const composioMadeKey = (name: string): string => `mcp.composio/${name}`;

/** The settings value a record is stored as, bound to the server row it was written for. */
export const storedMade = (made: ComposioMade, row: { createdAt: number }): ComposioMade & { of: number } => ({ ...made, of: row.createdAt });

const ID = /^[A-Za-z0-9_.-]{1,128}$/;
const thingOf = (value: unknown): Made | undefined => (isObject(value) && typeof value.id === "string" && ID.test(value.id) && typeof value.made === "boolean" ? { id: value.id, made: value.made } : undefined);

/** A stored record read for the row created at `createdAt`; undefined when there is none, it was written for another row,
 *  or it is not one (then nothing beyond the MCP server is removed). */
export function recordedMade(value: unknown, createdAt: number | undefined): ComposioMade | undefined {
  if (!isObject(value) || createdAt === undefined || value.of !== createdAt || typeof value.user !== "string" || !Array.isArray(value.accounts)) return undefined;
  const config = value.auth_config === null ? null : thingOf(value.auth_config);
  const accounts = value.accounts.map(thingOf);
  if (config === undefined || accounts.some((account) => !account)) return undefined;
  return { user: value.user, auth_config: config, accounts: accounts as Made[], ...(value.per_run === true ? { per_run: true as const } : {}), ...(value.key_env === COMPOSIO_KEY_ENV ? { key_env: COMPOSIO_KEY_ENV } : {}) };
}

/** Whether the saved server `row` is a per-run Composio server: auth headers (the install's sealed key) and its own
 *  record (`recorded`, read at composioMadeKey) saying per_run. Its runs call it as the Composio user and account each
 *  names (mcp_auth.<server> = {composio_user_id, connected_account_id?}); one that names none is refused unsent. */
export const composioPerRun = (row: { auth: string; createdAt: number }, recorded: unknown): boolean => row.auth === "headers" && recordedMade(recorded, row.createdAt)?.per_run === true;

/** Whether `other` stands on `mine`'s account: under the same auth config, as the same user (Composio's MCP server picks
 *  the account by the two). */
const sharesAccounts = (mine: ComposioMade, other: ComposioMade): boolean => mine.auth_config !== null && other.auth_config?.id === mine.auth_config.id && other.user === mine.user && !mine.per_run && !other.per_run;

/** A record a save writes, from what the preset found and made (`found`): a thing it found that a record of the server
 *  saved before over this row (`was`) or of another saved server (`others`) says was made here stays made here; and the
 *  accounts the server saved before had made, under the same auth config and user, stay its own. */
export function madeToWrite(found: ComposioMade, was: ComposioMade | undefined, others: readonly ComposioMade[]): ComposioMade {
  const all = [...(was ? [was] : []), ...others];
  const madeHere = (id: string) => all.some((r) => r.auth_config?.id === id ? r.auth_config.made : false) || all.some((r) => r.accounts.some((a) => a.id === id && a.made));
  // One the owner named is theirs, whatever a record says made it.
  const config = found.auth_config && { id: found.auth_config.id, made: !found.auth_config.named && (found.auth_config.made || madeHere(found.auth_config.id)) };
  const accounts = found.accounts.map((a) => ({ id: a.id, made: a.made || madeHere(a.id) }));
  const kept = was && sharesAccounts(found, was) ? was.accounts.filter((a) => a.made && !accounts.some((b) => b.id === a.id)) : [];
  return { user: found.user, auth_config: config, accounts: [...accounts, ...kept], ...(found.per_run ? { per_run: true as const } : {}), ...(found.key_env ? { key_env: found.key_env } : {}) };
}

/** The value of `name`, a server's key variable (ComposioMade.key_env), in `env` as it is now: trimmed, none when unset,
 *  blank or longer than any key. Read at each use, never kept. */
export function composioKeyFromEnv(name: typeof COMPOSIO_KEY_ENV = COMPOSIO_KEY_ENV, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  return value && value.length <= 8192 ? value : undefined;
}

/** Why the server `server`, which reads its key from `name`, can't be used now: the variable is unset. */
export const composioKeyUnset = (server: string, name: string = COMPOSIO_KEY_ENV): string =>
  `The MCP server ${server} reads its Composio key from the environment variable ${name}, which is not set: set it where AgentRun runs, then try again.`;

/** Why the server `server`, which reads its key from `name`, is never sent it: its address is not on Composio's origin. */
const composioKeyOffOrigin = (server: string, url: string, name: string, origin: string): string =>
  `The MCP server ${server} reads its Composio key from the environment variable ${name}, and its address (${originOf(url)}) is not Composio's (${origin}): that key is only ever sent to Composio. Save it again with the Composio preset.`;

const originOf = (url: string): string => {
  try { return new URL(url).origin; } catch { return "not a URL"; }
};

/** The key the server `server` (its address `url`) reads from `name`, its record's key_env, for a request to that address:
 *  the variable's value now, only while the address is on Composio's origin (`origin`, COMPOSIO_ORIGIN; a test's fake
 *  through the server's and runner's seam). Otherwise why not, in words, and the caller sends nothing: `not_allowed`, an
 *  address no preset save writes (a row written by hand); `missing`, the variable unset. Every read of such a key for a
 *  request to the server's address goes through here: a save's and a refresh's listing, a run's start, a claim. */
export function composioEnvKey(server: string, url: string, name: typeof COMPOSIO_KEY_ENV, origin: string = COMPOSIO_ORIGIN): { key: string } | { refused: string; reason: "not_allowed" | "missing" } {
  if (originOf(url) !== new URL(origin).origin) return { refused: composioKeyOffOrigin(server, url, name, origin), reason: "not_allowed" };
  const key = composioKeyFromEnv(name);
  return key ? { key } : { refused: composioKeyUnset(server, name), reason: "missing" };
}

/** The records of the other saved servers (`others`, by name) that say they made the auth config `id`, each as it is to
 *  be written once the owner named that config in a save: made by none of them, so none of their deletes removes it. */
export function releasedOf(id: string, others: readonly (readonly [string, ComposioMade, ...unknown[]])[]): [string, ComposioMade][] {
  return others.filter(([, record]) => record.auth_config?.id === id && record.auth_config.made).map(([name, record]) => [name, { ...record, auth_config: { id, made: false } }]);
}

/** What a removed server's record leaves to do, with the records of the servers still saved (`others`, by name): each
 *  thing it made that none of them uses is removed; one another uses is kept and passed to that one (`handover`: its record
 *  as it is to be written, owning it); one it didn't make is kept. */
export function cleanupOf(mine: ComposioMade, others: readonly [string, ComposioMade][], withConfig = true): { cleanup: Cleanup; handover: [string, ComposioMade][] } {
  const cleanup: Cleanup = { remove: [], kept: [] };
  const handed = new Map<string, ComposioMade>();
  const take = (name: string, record: ComposioMade) => handed.get(name) ?? (handed.set(name, { ...record, accounts: [...record.accounts] }), handed.get(name)!);
  for (const account of mine.accounts) {
    const user = others.find(([, other]) => sharesAccounts(mine, other));
    if (!account.made) cleanup.kept.push({ kind: "account", id: account.id });
    else if (user) {
      cleanup.kept.push({ kind: "account", id: account.id, by: user[0] });
      const record = take(user[0], user[1]);
      record.accounts = [...record.accounts.filter((a) => a.id !== account.id), { id: account.id, made: true }];
    } else cleanup.remove.push({ kind: "account", id: account.id });
  }
  if (mine.auth_config && withConfig) {
    const config = mine.auth_config;
    const user = others.find(([, other]) => other.auth_config?.id === config.id);
    if (!config.made) cleanup.kept.push({ kind: "auth_config", id: config.id });
    else if (user) {
      cleanup.kept.push({ kind: "auth_config", id: config.id, by: user[0] });
      take(user[0], user[1]).auth_config = { id: config.id, made: true };
    } else cleanup.remove.push({ kind: "auth_config", id: config.id });
  }
  return { cleanup, handover: [...handed] };
}

/** What a save over a server leaves to do at Composio, with the records of the other servers saved (`others`, by name):
 *  what the record it replaces (`was`) made that the one written now (`now`) no longer stands on, an account of another
 *  user or auth config, and an auth config of another toolkit, each removed or passed on as a delete's is (cleanupOf). */
export function droppedOf(was: ComposioMade, now: ComposioMade, others: readonly [string, ComposioMade][]): { cleanup: Cleanup; handover: [string, ComposioMade][] } {
  const accounts = was.accounts.filter((account) => account.made && !now.accounts.some((kept) => kept.id === account.id));
  // The auth config goes through only when this save stands on another one: its accounts are checked under it either way.
  const config = was.auth_config !== null && was.auth_config.made && now.auth_config?.id !== was.auth_config.id;
  return cleanupOf({ user: was.user, auth_config: was.auth_config, accounts }, others, config);
}
