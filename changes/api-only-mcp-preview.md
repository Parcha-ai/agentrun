---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server with `AGENTRUN_API_ONLY_MCP_ORIGINS` set now serves the API token's `POST /v2/settings/mcp-servers/preview` for the body its save takes there: a `per_run` server at a listed origin. A backend can list such a server's tools before it saves it. Any other preview body (another origin, another auth type, no auth, or a saved server's name alone) is `404`, as the route was before, and nothing reaches the address. With the setting unset the preview stays `404`.

The token's write over a saved server it may not write (one it did not save, or one that keeps a credential) is still `403 forbidden`, now in words that name the server and say why: "The MCP server <name> was not saved by the API token, so the token can't save over it or remove it…". Before, it read as the secret-write refusal ("the API token can't write secrets") even when the body sent no secret. The error code is unchanged.
