---
packages: @parcha/agentrun-serve
kind: fix
---
On an API-only server, the other refusals the token gets no longer send it to the owner's signed-in session or console, which an API-only server does not have. A credential's value sent by the token (an MCP server's headers or bearer token, a Composio `api_key`) is refused (403) in words that say what it can send instead: an MCP server saved as `per_run`, each run handing its credential in `mcp_auth`, or a Composio key named by `api_key_env`. A Composio listing that sends a key says to name it by `api_key_env`. The OpenAPI `forbidden` description says `details.console_url` is absent on an API-only server. A full server's refusals are unchanged.
