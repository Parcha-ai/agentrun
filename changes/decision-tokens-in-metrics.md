---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A workflow's decision requests (its judge, pick, sift, route, ask and verify nodes on Jev or Parallel) count in its run metrics, so `/v2/stats` and Mission Control no longer undercount a workflow's tokens. `runMetricsOf(records, decisions?)` takes the run's decision receipts beside its entries: each is a request, by `provider/model`, with its `usage` (`input_tokens`, `output_tokens`) in the token sums; a receipt with no usage, or a cancelled one, is counted in `unmetered`, never as 0 tokens. serve passes a workflow run's receipts at its end.
