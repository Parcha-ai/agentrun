---
packages: @parcha/agentrun-serve
kind: feature
---
`GET /v2/runs/{run_id}` says what a run's paid tool calls cost: `cost.tools_usd`, the part of `cost.usd` that went to monid's endpoints, MCP tools with a saved price, Parallel behind the web tools and browser time, as the run's ledger booked them and rounded as `usd` is. It is inside `usd`, never added to it, so a host that bills model spend from its own gateway can bill the tool part apart. 0 for a run with no paid call; null while a paid call's charge is unknown, and for an imported run. `usd`, `learning_usd` and `all_in_usd` are unchanged, and the run list and the agent's cost rows don't carry it.
