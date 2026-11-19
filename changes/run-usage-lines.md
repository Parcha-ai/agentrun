---
packages: @parcha/agentrun-serve
kind: feature
---
`GET /v2/runs/{run_id}/usage` (`runusage/1`) gives one run's usage lines, for an operator who bills or accounts for runs: `tokens` per model (tokens by kind, requests, and how the figure was reached), `tools` per charger (calls), `browser_time` per provider (seconds), each with this server's cost figure and its basis (`reported`, `estimate`, `unpriced`). The lines join to `total_usd`, the run's `cost.usd`. A charge of unknown cost makes its line's `usd` null, never $0. While the run is at work, and for a run whose figure is not its booking's (imported, native, SDK) or a learning run a follow-up reopened, `lines` is null and `reason` says why.
