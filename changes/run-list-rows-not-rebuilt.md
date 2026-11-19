---
packages: @parcha/agentrun-serve
kind: breaking
---
Upgrading from 0.1.0-beta.46 or earlier: a run-list row that server cached is not rebuilt for the new `path` and `workflow` fields, so `GET /v2/runs` and `GET /v2/agents/{agent_id}/runs` can show such a run without them until the run changes. `GET /v2/runs/{run_id}` has both.
