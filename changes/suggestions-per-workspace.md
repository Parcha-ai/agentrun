---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server now serves suggested agents to a scoped request (the `AgentRun-Workspace` header): `GET /v2/suggestions`, `POST /v2/suggestions/scans`, `GET /v2/suggestions/{id}`, its discard, restore and create, `GET /v2/integrations/github` and `GET /v2/integrations/github/repositories`. Each workspace keeps its own suggestions and scans, scanned by its own scout agent; another workspace's suggestion answers the same 404 as an unknown id. The server's GitHub App is its operator's, so a workspace never reaches it: GitHub reads as not connected (`{"connected": false}`, and 409 `github_not_connected` for the repository list and for a create), and a scan reads the public repository anonymously. Connecting, disconnecting and the install callbacks stay refused to a scoped request (403 `not_scoped`).
