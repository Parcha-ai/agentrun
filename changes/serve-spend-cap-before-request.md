---
packages: @parcha/agentrun-serve
kind: fix
---
`max_cost_usd` is now a cap, checked before each model request in the run's own process: when what the run has spent plus the request's worst case (its input tokens at the model's input price, its max output tokens at the output price) would pass the cap, the request is not sent and the run ends `failed` with `spend_cap_reached`. Before, it was checked only after each response, so one request could cost any amount over the cap. Spent so far is read back from the run's store when its process starts, so it survives a restart. The server's check after each response stays as a backstop, and a run the cap stopped now keeps the answer it paid for in `result.final_answer` instead of `result: null`.

A cancelled run, and any run that made no model request, now costs $0 instead of `null`, and `/v2/usage` adds a run whose cost is unknown as $0, so one such run no longer makes every total and line `null`. The README says what `limits.max_cost_usd: null` means: no ceiling on the cap a run may name.

A response of unknown price (one with no cost in its usage) leaves its run's `cost.usd` `null`, never $0, and `/v2/usage` counts such runs in `unpriced_runs`, in its total and in each line, beside the dollars of the runs whose cost is known.
