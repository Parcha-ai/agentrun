---
packages: @parcha/agentrun-serve
kind: fix
---
AgentRun Server caps its concurrent runs, says whether it can work, and settles runs a full disk left behind.

- The most runs at once (each with a live process) is `--max-runs N` or `AGENTRUN_MAX_RUNS`, by default `max(1, floor((memory − 128 MiB) / 72 MiB))` from the container's memory limit or the machine's (5 on a 512 MB instance, which ran out of memory at about 6 before). Over it, `POST /v2/agents/{id}/runs` is `429 rate_limited` with `retry-after`, and nothing starts. `capabilities.limits.max_concurrent_runs` reports it.
- `GET /v2/health`, with no credential, is `200` when the agent store opens for a read and the data directory's disk has 64 MiB free (`AGENTRUN_MIN_FREE_MB`), else `503` naming the check that failed, and no path, size or version. Compose's healthcheck and `render.yaml`'s `healthCheckPath` use it; before, the health check was `/v2/capabilities`, which stayed `200` on a full disk.
- A run whose end the agent store cannot write (a full disk) still ends: a cancel makes it `cancelled`, priced from its rows, where before it stayed `queued` or `working` and cancel could not settle it. The server writes the end again every 30 s until it lands.
- A message to a run whose process was killed opens it again at once, where before it was `503` for up to the 90 s lease: a heartbeat of a process that is gone is no longer trusted.
- A free-disk reading that fails is `disk: "cannot_check"` (`503`), never room. A data directory serves one AgentRun Server at a time; two on a shared disk are not supported.
