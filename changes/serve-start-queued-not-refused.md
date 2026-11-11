---
packages: @parcha/agentrun-serve
kind: breaking
---
A start over the run limit is queued, not refused: a run start past `--max-runs` (by default, as many pi runs as the host's memory holds) answers `202` with the run `queued`, and the runner takes it up when a place frees, where the server once answered `429 rate_limited` with `retry-after`. A client that retried on that 429 can drop the retry and follow the run. A harness whose one run never fits the host is still refused at once (`409 agent_not_runnable`).
