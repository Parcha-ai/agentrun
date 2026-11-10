---
packages: @parcha/agentrun-serve
kind: fix
---
The runner honours `--drain-timeout` and `--max-runs` again. When the server stops (a redeploy, a restart, Ctrl-C), each busy run now finishes its turn for up to `--drain-timeout` (default 30s; the image's is 6s) and keeps its outcome, where before the turn was cut at once and its model request, already paid, was sent again on the resume. And the runner holds at most `--max-runs` runs at once (`AGENTRUN_MAX_RUNS`, else as many pi runs as the host's memory holds, the number the capabilities' `max_concurrent_runs` report); the rest wait queued, where before it took up to 300 at once and could run a small host out of memory. A runner of its own (`agentrun-serve runner`, beside a `--no-runner` server) holds the same: `--loops`, else `AGENTRUN_MAX_RUNS`, else what its host holds, and on SIGTERM it drains for `--drain-timeout` (new; default `AGENTRUN_DRAIN_TIMEOUT`, else 6s).
