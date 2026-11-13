---
packages: @parcha/agentrun-serve
kind: feature
---
Settings → MCP servers has a Composio preset: give a Composio API key, a toolkit and the actions to grant, and the server has Composio make a managed MCP server and saves it as an ordinary MCP server with the key sealed as an `x-api-key` header. It is `POST /v2/settings/mcp-servers/composio/tools` (the toolkit's actions) and `PUT /v2/settings/mcp-servers/{name}/composio`, both the owner's session alone; a toolkit that needs the person's account answers `connect_url`, Composio's page to connect it.
