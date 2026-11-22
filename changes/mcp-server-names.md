---
packages: @parcha/agentrun-serve
kind: feature
---
`GET /v2/settings/mcp-server-names` answers the names of the MCP servers saved here, `{names}`, and nothing else of them: no URL, auth type, header, tool or Composio record. It takes the server's token and is served on an API-only server too (`AGENTRUN_API_ONLY=1`), so a host that builds runs from saved servers can hold back a job whose server isn't saved before its launch is refused for it.
