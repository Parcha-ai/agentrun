---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent, @parcha/agentrun-kernel
kind: feature
---
A run whose cost is unknown because requests were cut (a crash) or stopped before their end (a stop, a cancel, a drain) now says the most it can be, with or without a spend cap, when its model has a price: `cost.at_most_usd`, the known costs plus those worst cases, beside `usd: null`, on the run, the run list, the timeline page and its usage row. Each request carries its worst case (its input bound and output ceiling at the model's price) to its marks; with no cap it is only measured, never refused. A model with no price, or anything else unknown, leaves no bound. `GET /stats` counts such runs apart, in `cost.bounded_unknown` and `analytics.totals.bounded_unknown` (`runs`, `at_most_usd`), never in the known sum.
- On claude-agent and codex each request's start mark on the run now carries its worst case, as on pi: the runner's `request_start` event gains `heldUsd`. A cap still reads the runner's own records.
- The agent store keeps a run's bound in a new table, `run_cost_bounds`: `carryBack` takes `atMostUsd`, `RunRow` has it, and `stats()` and `analytics()` count `boundedUnknown`.
- A paid tool's call a crash cut, or one charged an amount no one knows, counts in the bound at what its call was held to (its mark's `heldUsd`); one with no figure leaves no bound.
