---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
The Composio listings (`POST /v2/settings/mcp-servers/composio/toolkits` and `.../composio/tools`) take `"api_key_env": "COMPOSIO_API_KEY"` in place of `api_key`, as the Composio save does: the key is read from the server's environment and never sent by the caller. On an API-only server (`AGENTRUN_API_ONLY=1`) the token, scoped to a workspace or not, now lists Composio's toolkits and a toolkit's actions this way, so a backend in front of it can show its own picker. A key the token sends as `api_key` is still `403`, and on any other server the token's listing stays `403`.
