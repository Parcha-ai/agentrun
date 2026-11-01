---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: feature
---
`GET /v2/stats` answers `analytics`: the runs' tokens, requests, time and tool calls summed from the metrics the agent store keeps, over the runs not archived that the new optional `from`, `to` (RFC 3339) and `agent` query parameters pick (400 when one is malformed). It gives `totals` with coverage (`runs` beside `runs_with_metrics`, so a run with no metrics never reads as 0 tokens), `time`, `by_harness_effort`, `by_day` (UTC), `by_source` (`live` or the source an imported run came from) and the top 20 `tools`. Every other field of the answer is unchanged and stays the whole store's. The store reads it with `store.analytics({ from?, to?, agent? })`, SQL over `store.sqlite` alone in one snapshot; a store without the metrics tables answers with none. The served document marks the addition `stats/2`.
