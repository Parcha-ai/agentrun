---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
**`/v2/stats` counts an escalated run as completed and needing review, never as failed**
- An escalated workflow run is `completed` on `/v2/runs`, with a `review`, but `/v2/stats` counted it as failed: `runs.failed` added the escalated runs, and each analytics group counted them in `failed`. Now `runs.failed` counts failed runs alone, and `runs.needs_review` counts the escalated ones. Each analytics group (totals, by harness and effort, by day, by source) counts an escalated run in `completed`, with `needs_review` beside it, under the agent and date filters too. The new fields are marked `stats/3`.
- The agent store's `AnalyticsGroup` gains `needsReview`, and its `completed` includes the escalated runs, which its `failed` no longer counts.
- A client that showed `failed` as "failed or escalated" should show `needs_review` beside it.
