---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
Deleting a Composio server in Settings → MCP servers now also removes what its save made in your Composio account, not just the Composio MCP server. That covers the connected account its connect link started (the pending link with it) and the auth config it made.
- **Kept while shared:** what another saved server still uses stays until the last of them is deleted.
- **Never deleted:** anything that was there before the save, such as an auth config or account you already had.
- **The answer:** a Composio server's `DELETE /v2/settings/mcp-servers/{name}` answers `200 {deleted: true, composio: {removed, note}}`. The note says what it removed, what it kept and why, and what is left when Composio refused or didn't answer (`removed: false`). The server is forgotten here either way. Before, a full removal answered `204` with no words.
- **Older servers:** a server saved before this change has no record of what its save made, so its delete removes only the Composio MCP server, as before.
- **A failed save:** a save that fails after Composio made something removes what it made (the MCP server, the account its connect link started, the auth config it made), never what it found. When Composio refuses that too, the error says what is left there.
- **A save over a server:** saving a Composio server again as another `user_id`, or with another toolkit, removes the account or auth config the earlier save made and the server no longer uses, unless another saved server uses it. The save's answer then carries `composio: {removed, note}`, as a delete's does.
- **One at a time:** Composio saves and MCP server deletes now run one after another, so a delete never removes an auth config or account that a save still in progress is reusing.
- **The console:** it shows the note, as a success when nothing is left.
