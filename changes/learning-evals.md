---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: feature
---
An agent's Learning tab heads with its latest eval record: its held-out accuracy with the 95% Wilson interval and n, and the cost a task with learning against by hand; "Not measured yet" until one is recorded. Under the cost per run, on its run axis, the execution mix shows the share of runs each path took, block by block.
`POST /v2/agents/{id}/learning/evals` appends a record of a held-out test's counts (`name`, `label_source`, `n`, `correct`, `cost_per_task_usd`, `baseline_cost_per_task_usd`, `learned_revision`); the server computes `accuracy` and its Wilson `ci`, and refuses a body that sends either. `GET` answers the `latest` and the list, newest first, the latest 20. Only what was posted is shown: nothing is computed from the agent's own runs. `agentrun learning record-eval --body @eval.json` and `agentrun learning evals` do the same.
