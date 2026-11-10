---
packages: @parcha/agentrun-serve
kind: feature
---
See learning at work, from the server:
- A learned workflow's call shows which of its nodes ran: its `tool_result` row in a run's timeline carries `learned_nodes`, each node's label, kind, how it ended (`ok`, `failed`, `escalated`), how long it took and, when it failed, why (cut of the server's secrets).
- An agent whose learning is only skills or only workflows now has an impact: a run that started from a learned skill or workflow counts on the "after" side, as one that started from a note does. A run's launch records the learned workflows it was offered beside its skills.
- `GET /runs/{id}/learning` says which learned skills the run was offered and whether its job read each one (`skills`), and which learned workflows it called, how many times and how many of those failed (`workflows`).
There is no "saved vs by hand" figure per run: no per-run baseline exists that is not a guess; the agent's impact (before and after) says it per agent.
Upgrading: a client reading `GET /runs/{id}/learning` gets two new fields, `skills` and `workflows` (empty lists when none), and a timeline row may carry `learned_nodes`.
