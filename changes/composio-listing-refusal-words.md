---
packages: @parcha/agentrun-serve
kind: fix
---
A Composio toolkit or tool listing (`POST /v2/settings/mcp-servers/composio/toolkits` and `.../tools`) that the API token may not make was refused with the secret write's words, "Saving, replacing or removing a secret...", though a listing saves nothing. It now has its own `403`: on an API-only server, "A listing that sends a key's value takes the owner's signed-in session; on this server name the key by api_key_env instead."; on any other server, "Listing Composio's toolkits or tools takes the owner's signed-in session in the console; the API token lists them only on an API-only server, with the key named by api_key_env." Who may list is unchanged, and every real secret write keeps its words.
