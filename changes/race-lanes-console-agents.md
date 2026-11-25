---
packages: @parcha/agentrun-serve
kind: fix
---
A race's lanes are the console's own agents, no longer inline runs on external agents the Agents list could only read. Each lane makes an agent `race-<label>-<n>-<pick>` (POST /v2/agents) and starts its run, labeled and capped as before, on that agent's first revision (POST /v2/agents/{id}/runs), so a resend after a lost answer never runs an edited agent. A lane picked again after a refusal archives the agent it had. A refused last lane can be removed (its agent archived), and the race opens once every lane left has a run.
