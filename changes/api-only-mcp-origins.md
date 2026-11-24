---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) can now take a per_run MCP server save from its token, at origins its operator names in `AGENTRUN_API_ONLY_MCP_ORIGINS` (comma-separated, for example `http://127.0.0.1:4001`). A backend in front of the server can save its gateway (`PUT /v2/settings/mcp-servers/{name}` with `"auth": {"type": "per_run"}`) on a fresh install or after a store reset, without turning API-only off for the save. Runs still bring their own credential in `mcp_auth`, and the server keeps none. A body that carries a credential is `403`, and so is a save over a server the token did not save or one that seals a credential. A per_run body at any other origin, any other auth type and a Composio server's name are the profile's `404`. Each refusal comes before anything is sent to the address. With the setting unset or blank, the save is a `404` as before. A loopback origin still needs `AGENTRUN_MCP_ALLOW_LOOPBACK=1`.
