---
packages: @parcha/agentrun-serve
kind: fix
---
Deleting a Composio preset server in Settings → MCP servers also deletes the MCP server the preset made in your Composio account, using the saved key, so nothing is left behind there. Composio saying it is already gone is fine; if Composio refuses or does not answer, the server is still forgotten here and the answer (`200 {deleted: true, composio: {removed: false, note}}`) and the console say what to remove in Composio yourself. Any other server is deleted as before (204).
