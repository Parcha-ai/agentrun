---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: feature
---
An agent that learns shows its cost per run, run after run: the Learning tab draws every run's all-in cost (the run's own plus what learning spent for it) as a dot coloured by the path it took (by the agent, a learned workflow that handed back, or a learned workflow alone), a rolling mean through them, the agent's level before learning, a marker where a learned workflow first finished a run alone, and the level held after it, with how many times cheaper once 20 runs stand behind it. A table under it holds every run.
`GET /v2/agents/{id}/learning/cost` (`learningcost/1`) answers the same series and summary, aggregates only (`?limit=`, `?format=csv`); `agentrun learning cost <agent> [--format csv]` prints it or writes it as CSV.
