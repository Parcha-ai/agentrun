---
packages: @parcha/agentrun-serve, @parcha/agentrun-dsl, @parcha/agentrun-decisions, @parcha/pi-durable-agent
kind: feature
---
A workflow run takes a spend cap (`max_cost_usd`, `cap_mode`), on its start, from its agent's default (a workflow definition now keeps one), and from a trigger, which may now start a workflow. Each paid step is held to the cap before it is sent, as an agentic run's are: a model node's request, a call node's `llm` call and paid tool call, and a decision at its provider's price (Parallel's list price, Jev's published price, an OpenRouter Decisions model's catalog price). A step the cap has no room for waits unsent where it stands: the run is `input_required` with `pending.kind` budget and `pending.node`, and `PATCH /runs/{id}` sends it, in the same process or, after 10 minutes paused, in one opened again from the run's journal, with no completed node sent again. A step no raise fixes (a decision model with no price) ends the run `failed`, `spend_cap_reached`.
- `@parcha/agentrun-dsl`: `WorkflowDeps.held(executionPath)`, the time a host held a call, which its deadline does not count; `chargedCost` is exported.
- `@parcha/agentrun-decisions`: the OpenRouter provider's `priceOf(model)`, the model's catalog price.
- `@parcha/pi-durable-agent`: a workflow revision keeps `maxCostUsd` and `capMode`.
