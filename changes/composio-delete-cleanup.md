---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
Deleting a Composio server in Settings → MCP servers now also removes what its save made in your Composio account, not just the Composio MCP server. That covers the connected account its connect link started (the pending link with it) and the auth config it made.
- **Kept while shared:** what another saved server still uses stays until the last of them is deleted.
- **Never deleted:** anything that was there before the save, such as an auth config or account you already had.
- **The answer:** a Composio server's `DELETE /v2/settings/mcp-servers/{name}` answers `200 {deleted: true, composio: {removed, note}}`. The note says what it removed, what it kept and why, and what is left when Composio refused or didn't answer (`removed: false`). The server is forgotten here either way. Before, a full removal answered `204` with no words.
- **Older servers:** a server saved before this change has no record of what its save made, so its delete removes only the Composio MCP server, as before.
- **The console:** it shows the note, as a success when nothing is left.
