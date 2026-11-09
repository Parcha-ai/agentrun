---
packages: @parcha/agentrun-serve
kind: breaking
---
The store's schema version moves with the MCP access token's end, now kept by the store's own clock (`mcp_servers.token_until`): a data directory an earlier build wrote is refused at start, naming both versions, and never migrated. Start the server on a fresh data directory.
