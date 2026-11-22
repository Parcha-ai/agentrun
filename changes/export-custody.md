---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/agents/{agent_id}/package` no longer copies a credential in the clear into a package. A trigger's source (a feed URL with a `?token=`, `?key=`, `?sig=` or `?password=` query, an address with a user part), its run input (an `api_key` field) and an MCP tool's pin are read the way a composio trigger's config is sealed, and each credential is a `report.blocked` entry of kind `trigger` or `pin` named by its field (`Status: source.urls.0`, `slack: pin.post.api_key`), never by its value. The trigger or pin is left out, and `agentrun export` and `agentrun deploy` write nothing and exit 2, as they do for any blocked entry. A query such as `?page=2` still exports. `report.blocked[].kind` and `report.remade[].kind` are now an enum in the OpenAPI document, so the generated clients type them.
