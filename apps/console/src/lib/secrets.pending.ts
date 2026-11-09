/** PENDING: the ruled secret read (tl-untangle, 11-09) until the switch slices land (tl-mcp, tl-places, tl-triggers,
 *  tl-tools). Imported only through v2.ts's aliases, and swapped there for the generated ones when they land, before
 *  anything is taken in. Every secret read uses this one shape. */
export type SecretField = {
  name: string;
  set: boolean;
  /** env: set where the server starts (it wins); console: pasted here; sign-in: from an OAuth sign-in or Connect. */
  source: "env" | "console" | "sign-in" | null;
  /** When it last changed; null where nothing set it here (the environment's, or none). */
  changed_at: string | null;
};
/** GET /v2/auth/session's additions (PENDING, proposed to tl-tools 11-09): `secrets_writable`, true only for the session
 *  that may paste a secret (the owner's password session; on a server with no accounts, the console session the launcher
 *  opened on loopback); `secrets_reason`, why not; `accounts: false`, a server with no accounts answering the read. */
export type SessionSecrets = { secrets_writable?: boolean; secrets_reason?: "sign_in" | "no_accounts"; accounts?: false };
/** A tool or model key's fields, in the ruled shape (`stored_unreadable`: saved here, and it no longer opens). */
export type PendingKeyField = SecretField & { stored_unreadable?: true };
/** An MCP server's credential values (its bearer token, each header's value), in the ruled shape. */
export type PendingMcpSecrets = { secrets?: SecretField[] };
