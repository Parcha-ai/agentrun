---
packages: @parcha/agentrun-serve
kind: breaking
---
API-only (`AGENTRUN_API_ONLY=1`): list the origin of every per_run MCP server the API token saved in `AGENTRUN_API_ONLY_MCP_ORIGINS` before upgrading, or token-saved per_run servers are refused. Every API-only start now holds the list it starts with (an empty one when the setting is unset), and a run that grants a token-saved per_run server at an origin off it fails with nothing sent, as does an agent's save that pins it. The start logs one line, `api_only_mcp_off_list`, with the count and names of those servers. Or re-save it from the owner's signed-in session with API-only off, which makes it the owner's and leaves the save closed: a server saved from the owner's session is not governed by the list, whenever it was saved.
