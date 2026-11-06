---
packages: @parcha/agentrun-serve
kind: feature
---
An agent that learns says how many of its learned items wait for its owner's OK: `GET /v2/agents` and `GET /v2/agents/{agent_id}` carry `learning: { pending }` (notes, skills and workflow drafts held with `status: pending` on its learning folder's main), read once per commit of main, never per list call. Absent for an agent that does not learn, and on a server whose learning is off.
