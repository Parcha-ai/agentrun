---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) can now take a per_run MCP server save from its token at the origins `AGENTRUN_API_ONLY_MCP_ORIGINS` lists, so a backend can save its gateway without turning API-only off. Runs still bring their own credential in `mcp_auth`, and the server keeps none (serve README, API only).
