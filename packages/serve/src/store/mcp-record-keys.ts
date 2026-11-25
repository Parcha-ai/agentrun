// The store.settings keys of the records about a saved MCP server, each bound to the server row it was written for by
// that row's created_at (`of`). The store reads them when it makes a row (Mcp.put): a new row of a name is made past
// every `of` they still hold, so a record about an earlier row of the name is never byte for byte a later row's.

/** What the server's tools are and who saved it (mcp-sources.ts). */
export const mcpSourceKey = (name: string): string => `mcp.source/${name}`;

/** What its Composio preset made (composio-made.ts). */
export const composioMadeKey = (name: string): string => `mcp.composio/${name}`;

/** Its Composio account as its last refresh read it: `{of, user, toolkit, auth_config, state, labels?, checked_at}`, bound
 *  to the server row (`of`) and to what it was read for, so a save over the server as another user, toolkit or auth
 *  config shows none until the next refresh. No id, no token. */
export const composioAccountKey = (name: string): string => `mcp.composio-account/${name}`;

/** Every record key of the server `name`. */
export const mcpRecordKeys = (name: string): readonly [string, string, string] => [mcpSourceKey(name), composioMadeKey(name), composioAccountKey(name)];
