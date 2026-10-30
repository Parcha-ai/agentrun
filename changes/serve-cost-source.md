---
packages: @parcha/agentrun-serve, @parcha/agentrun-pi, @parcha/agentrun-dsl
kind: feature
---
A run's cost says whether its provider reported it. `cost.source` is `reported` when the run made decisions, each decision's cost is its provider's own report (Jev's `usage.cost`), and the run made no model request. Every other run reads `estimate`. It is on the run, its summary in the runs list and its timeline page, and `/v2/openapi.json` marks it as the server's own (`cost/1`). `cost.basis` keeps the contract's values, and `cost.usd` is unchanged: an unknown cost still reads `null`, never `0`.
- A decision receipt keeps `cost_basis` (`reported`, `estimate` or `unknown`) when its judge gives one, and so does its row in `agentrun.decisions`. A replayed receipt gets it back.
- The run's end writes the source to its `serve.json`, so the runs list and the next server read it there. A run that ended before this reads `estimate`.
