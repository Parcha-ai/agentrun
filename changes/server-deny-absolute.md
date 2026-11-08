---
packages: @parcha/agentrun-serve
kind: fix
---
An agent's own ask or allow no longer overrides a deny set on the server; the call is refused on this server. A deny in the server's tool settings (`/v2/settings/tools`), under the tool's own key, its MCP server's wildcard (`mcp:<server>/*`) or bash's for a shell tool, is absolute: it holds over any setting in an agent's `definition.tool_settings`, a template's grant among them, and whatever the agent's `approvals`. The agent read says `permission: "deny"`, `permission_from: "server"`. With no server deny, the agent's own setting still comes first. Upgrading: an agent that set a tool to ask or allow on a server that denies it now has that tool refused; lift the server's deny to restore it.
