---
packages: @parcha/agentrun-serve
kind: feature
---
The runs lists (`GET /v2/runs` and `GET /v2/agents/{agent_id}/runs`) name the trigger that started each run, as the run's own view does: `trigger: {id, firing_key}`, or `null` for a run a caller started. An ended run listed after a restart reads it from the `serve.json` its list row already reads, so the list makes no extra read.
