---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A run a learned workflow answered alone says so where runs are read: `GET /v2/runs/{id}` and every row of `GET /v2/runs` carry `served: { workflow, digest }`, and a run the workflow ran first and handed back carries `handed_back: { workflow, digest }`, both read off the run's record as `GET /v2/agents/{id}/learning/cost` reads its `path`. A run by the agent, a check's replay run and an audit's shadow carry neither. The console's runs list reads "Learned workflow" in the Kind column for a served run, and its run page header reads "Learned workflow <name> · rev N"; a handed-back run reads "agentic · handed back by <name>".
A runs list builds again, once, any run's listing saved under an older listing format, so a run served before this release reads "Learned workflow" on the list as it does on its run page.
