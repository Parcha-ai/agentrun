---
packages: @parcha/agentrun-serve
kind: feature
---
A template eval's report keeps each run's metrics: `cases[].runs[].metrics` holds its input, cache-read, cache-write and output tokens, its model requests (and how many of them were unmetered), and its tool calls by tool, read from `GET /stats?agent=` over the run's own agent once the run has ended. A run whose end wrote no metrics, or whose read fails, has `metrics: null`; its result does not fail on them. Upgrading: nothing to do.
