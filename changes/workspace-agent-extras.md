---
packages: @parcha/agentrun-serve
kind: feature
---
A request in a workspace (`AgentRun-Workspace`, API-only) is now also served its agent's package (`getAgentPackage`), a revision's skills, its home's list, reads and removals, and a workflow's check (`POST /workflows/validate`). Another workspace's agent answers each of them the same `404` as an id no agent has. A home write and a sign-in's removal stay `403 not_scoped`: nothing bounds a home's size on a disk the workspaces share, and removing a secret takes the owner's session. A workspace's package reads its own MCP servers alone: a shared server, the operator's, is not the workspace's to read, so a granted tool of one is blocked as a server saved nowhere and nothing of its address reaches the package.
