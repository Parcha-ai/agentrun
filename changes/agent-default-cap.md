---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: feature
---
An agent can carry a default spend cap. A definition's `max_cost_usd` (a number above 0, agentic only) is kept with its revision, as `maxCostUsd` on the agent store's agentic body, and read back in `GET /v2/agents/{agent_id}`; a run started with no `max_cost_usd` of its own takes its revision's default, and a run's own cap wins. A workflow definition with one is `422 not_allowed`, since a workflow run's spend is not capped here, and an edit that leaves it out keeps none, as with `tool_settings`. A trigger's `start_run` target may now leave out `max_cost_usd` when its agent has a default: each firing takes the default as it stands when it starts, a target with neither is `422`, and a firing that finds neither fails rather than start an uncapped run.
