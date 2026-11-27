---
packages: @parcha/agentrun-serve
kind: feature
---
A request in a workspace (the `AgentRun-Workspace` header on an API-only server) can now read and change its own agents' learning: the view, reset, cost, promotions, audits, loop, log, corrections (read and write), a learned file's read and retire, a workflow's revisions and a replay's read, and a run's learning and its diff. Another workspace's agent or run answers the same `404` as an id no row has. A learned workflow's approve, restore and replay still take the owner's signed-in page, and stay `403 not_scoped` in a workspace. A request with no header is served as before: the API-only profile still refuses it the learning's texts and writes.
