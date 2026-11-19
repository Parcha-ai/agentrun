---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
The OpenAPI document requires what this server always sends: an agent's `kind`, `revision`, `revisions` and `archived_at` on every agent answer (a read, a list's, a create's and an edit's), and `harnesses` in `GET /v2/capabilities`. The generated TypeScript and Python client types follow. The console reads its agent and capabilities types from the generated ones instead of its own hand-written copies, so a capabilities `models.source` of `managed` or `env` and a save warning's `reason` are typed as the server sends them.
