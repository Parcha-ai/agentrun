---
packages: repo
kind: feature
---
The console's Settings → MCP servers: add a remote MCP server by its address and credential (none, a bearer token, headers, or Sign in with OAuth), preview the tools it lists and the protocol it speaks, then save it. A refusal reads in plain words (it asks for a token, it signs in with OAuth, it doesn't speak MCP, it redirects, it failed, no seal key). Each saved server shows its tool count and its credential's state (sealed, expired with Sign in again, can't be opened) with Refresh (what was added, removed and changed), Change and Delete; a saved credential is never shown, and a change that leaves it empty keeps it. The page says how a sign-in went when the browser comes back. The agent editor's Tools step lists each saved server's tools, a tick grants `mcp:<server>/<tool>`, and a grant whose server was deleted or no longer lists the tool says so. The timeline labels such a call `<server> · <tool>`.
- Settings lists MCP servers on every server. Capabilities' `features.mcp_client` no longer carries `routes`, which was always `true`: a client that read it reads the feature's presence instead.
