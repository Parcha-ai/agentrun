---
packages: @parcha/agentrun-serve
kind: feature
---
A request in a workspace (the `AgentRun-Workspace` header on an API-only server) is served `GET /v2/marketplace/templates`, where it was `403 not_scoped`. Each entry's `here` names only a package the workspace sees: a bundled one, or one its own workspace imported. Another workspace's import reads as not here. A request with no header sees every package, as before.
