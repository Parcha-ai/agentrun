---
packages: @parcha/agentrun-serve
kind: feature
---
A request in a workspace (the `AgentRun-Workspace` header on an API-only server) is now served four operations that used to answer `403 not_scoped`:
- `GET /v2/computers` lists the computers this server offers, without the operator's paired computers.
- `GET /v2/computers/running` lists only the workspace's own runs.
- `GET /v2/agents/{id}/archil` reads the disk of the workspace's own agent.
- `DELETE /v2/agents/{id}/archil` removes that disk.

Another workspace's agent reads as a missing one.
