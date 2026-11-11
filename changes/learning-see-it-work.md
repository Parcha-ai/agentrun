---
packages: @parcha/agentrun-serve
kind: feature
---
See learning at work, from the server:
- A learned workflow's call shows which of its nodes ran: its `tool_result` row in a run's timeline carries `learned_nodes`, each node's label, kind, how it ended (`ok`, `failed`, `escalated`) and how long it took; never why a node failed, whose text can hold part of a secret.
- An agent whose learning is only skills or only workflows now has an impact: a run whose claim laid a learned skill or workflow counts on the "after" side, as one that started from a note does. A run's launch records the learned workflows it was offered beside its skills, and its claim records which skills and workflows it laid.
- `GET /runs/{id}/learning` gains `used`: which learned skills the run was offered and whether its job read each one (`used.skills`), and which learned workflows it called, how many times and how many of those failed (`used.workflows`), apart from `skills` and `workflows`, what it learned.
There is no "saved vs by hand" figure per run: no per-run baseline exists that is not a guess; the agent's impact (before and after) says it per agent.
Upgrading: a client reading `GET /runs/{id}/learning` gets a new `used` object (empty lists when none), and a timeline row may carry `learned_nodes`.
