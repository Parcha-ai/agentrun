---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: fix
---
The MCP server list no longer documents `file_unreadable`, and the MCP routes no longer document `409 no_sealing_key` or `409 store_unreadable`. Those came from the file-era registry (`mcp-servers.json`), which the store-backed registry replaced; the server never sent them since. `ListMcpServersResponse` in the generated clients loses the field. A server does not start without its seal key, so no MCP save or sign-in is refused for want of one.
