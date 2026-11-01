---
packages: repo, @parcha/agentrun-serve
kind: feature
---
An agent's page in the console runs the agent. A run bar under its header takes an agentic agent's first message, or a workflow agent's input as JSON (prefilled with its example, else its fields empty), and an effort from the server's `features.efforts`. "default" sends no effort. A started run opens on its page. A refusal (a `409 agent_not_runnable`, a `422` with its fields) is shown in the bar, and sending again is the same request under the same `Idempotency-Key`. An archived agent has no run bar. The Runs tab shows each run's effort when it has one, because the server's runs index (`GET /v2/runs`, `GET /v2/agents/{id}/runs`) now carries a run's `effort` as `GET /v2/runs/{id}` does. The field is optional, absent for a run started with none, and marked `effort/1` in the served OpenAPI document.
