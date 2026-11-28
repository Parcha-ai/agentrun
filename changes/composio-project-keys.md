---
packages: @parcha/agentrun-serve
kind: feature
---
Composio servers and catalog listings accept `AGENTRUN_COMPOSIO_API_KEY` alongside `COMPOSIO_API_KEY` as an explicit `api_key_env`. Each saved server uses its recorded key name for its calls and cleanup, with no fallback to the other project; re-saving it under a different key name is refused before Composio is called. Both keys remain with the server and runners and are sent only to Composio; unrelated environment names remain refused. `features.mcp_client.composio_key_envs` advertises supported names. Upgrade the server and every runner before saving servers that select the new key.
