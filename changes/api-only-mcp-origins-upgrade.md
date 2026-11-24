---
packages: @parcha/agentrun-serve
kind: breaking
---
API-only: a per_run MCP server the token saved is refused unless `AGENTRUN_API_ONLY_MCP_ORIGINS` lists its origin; unset, the list is empty. Before upgrading, list the origin of each one, or re-save it from the owner's signed-in session with API-only off. An API-only start names the servers off the list in one log line, `api_only_mcp_off_list`.
