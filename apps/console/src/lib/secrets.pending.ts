import type { components } from "./api.generated";

/** PENDING until tl-mcp's slice: the one secret read the generated document doesn't carry yet. An MCP server holds one
 *  secret ("mcp:<server>", its bearer token or sign-in: `secret`) or several ("mcp:<server>:<header>": `secrets`), in the
 *  settled SecretMeta shape. Imported only through v2.ts; swapped there for the generated alias when the slice lands.
 *  (SecretMeta, the session's secrets fields and tool keys' `secrets` are generated now: tl-tools' secrets slice.) */
export type PendingMcpSecrets = { secret?: components["SecretMeta"]; secrets?: components["SecretMeta"][] };
