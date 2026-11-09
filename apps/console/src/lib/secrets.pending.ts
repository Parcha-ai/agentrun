/** PENDING: the settled secret read (SECRETS-PLAN "Shared pieces", 11-09) until the switch slices land (tl-mcp, tl-places,
 *  tl-triggers, tl-tools). Imported only through v2.ts's aliases, and swapped there for the generated ones when they land,
 *  before anything is taken in. Every secret read uses this one shape: an object holding one secret carries
 *  `secret: SecretMeta`, one holding several `secrets: SecretMeta[]`, no other field name. */
export type SecretMeta = {
  /** "<plane>:<id>": tool:<KEY>, model:<KEY>, mcp:<server>[:<field>], computer:<provider>:<KEY>, workspace:archil,
   *  trigger:<id>, webhook:outbound, github:app, source:<adapter>:<field>. Never shown: secretLabel says it. */
  name: string;
  set: boolean;
  /** env: set where the server starts (it wins); console: pasted here; sign-in: from an OAuth sign-in or Connect. */
  source: "env" | "console" | "sign-in" | null;
  /** The credential's own last change; null where nothing set it here (the environment's, or none). */
  changed_at: string | null;
};
/** GET /v2/auth/session's additions (PENDING, tl-tools' slice, 11-09): it answers on every server. `accounts`: false on a
 *  server with no accounts (then no user fields); `secrets_writable`, true only for the session that may paste a secret
 *  (the owner's password session; with no accounts, the console session the launcher opened on loopback); and, only when
 *  false, `secrets_reason`: "sign_in", "no_accounts" (not on loopback), or "token" (a browser on the API token alone). */
export type SessionSecrets = { accounts?: boolean; secrets_writable?: boolean; secrets_reason?: "sign_in" | "no_accounts" | "token" };
/** A tool or model key holds several (its fields): `secrets`, each "tool:<KEY>" or "model:<KEY>". */
export type PendingKeySecrets = { secrets: SecretMeta[] };
/** An MCP server holds one (its bearer token: "mcp:<server>") or several (its headers' values: "mcp:<server>:<field>"). */
export type PendingMcpSecrets = { secret?: SecretMeta; secrets?: SecretMeta[] };
