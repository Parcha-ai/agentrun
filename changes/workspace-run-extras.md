---
packages: @parcha/agentrun-serve
kind: feature
---
A request in a workspace (`AgentRun-Workspace`, API-only) is now also served a run's graph and trace, cap raise, pause, resume, archive, unarchive, grade, held start and purge (`deleteRun`). Another workspace's run answers each of them the same `404` as an id no run has, and so does a run another workspace purged. Before, each was `403 forbidden` with `details.reason: "not_scoped"`. Answering a tool call's approval stays out of a workspace's routes: it takes the owner's session alone, never a token.
