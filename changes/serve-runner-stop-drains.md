---
packages: @parcha/agentrun-serve
kind: breaking
---
A stop now drains: the server's own runner lets each busy run finish its turn for up to `--drain-timeout` (default 30s), and a runner process (`agentrun-serve runner`) for up to `--drain-timeout` or `AGENTRUN_DRAIN_TIMEOUT` (default 6s), before it hands the rest back. For the old instant hand-back, pass `--drain-timeout 0s`.

A runner now holds at most `--max-runs` runs at once (a runner process: `--loops`), default `AGENTRUN_MAX_RUNS`, else as many pi runs as the host's memory holds, where it took up to 300 before. To raise the cap, set `--max-runs`, `--loops` or `AGENTRUN_MAX_RUNS`.
