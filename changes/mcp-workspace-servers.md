---
packages: @parcha/agentrun-serve
kind: feature
---
On an API-only server, a request in a workspace (`AgentRun-Workspace`) is served the MCP servers' list, names, read, preview (of its own server, or an address at the operator's MCP origins), save, Composio save, refresh and delete, and reaches its workspace's own servers alone: another workspace's server of a name reads as a name never saved, a save of the name makes the workspace's own, and its agents reach their own server of a name before the install's shared one. A workspace's server is kept as `<workspace>/<name>`, with no schema change, and its sealed credential is bound to that row. A save in a workspace seals no credential: `per_run`, or a per-run Composio save with `api_key_env` (a `user_id` of its own or an `auth_config_id` is 422 `not_allowed`).
