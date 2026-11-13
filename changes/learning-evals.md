---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: feature
---
An agent's Learning tab heads with its held-out test: how accurate and how cheap the agent with what it learned is against the agent by hand, on jobs it never learned from, with how many jobs and the 95% interval; "Not measured yet" until one is recorded. Beside the cost per run, the execution mix shows the share of runs each path took, block by block.
`POST /v2/agents/{id}/learning/evals` records a test's result (`n`, and for `learned` and `by_hand` their `accuracy`, `ci` and `usd_per_job`, with a `source` label); `GET` lists them newest first, the latest 20. Only what was posted is shown: nothing is computed from the agent's own runs. `agentrun learning record-eval` and `agentrun learning evals` do the same.
