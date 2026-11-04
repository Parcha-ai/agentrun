---
packages: @parcha/agentrun-serve
kind: feature
---
The server admits runs by the memory their harness takes, not by a count that assumed every run costs the same. Each run with a live process reserves its harness's measured size (pi 128 MiB, codex 192 MiB, claude-agent 288 MiB) out of the container's memory limit, or the machine's, less the server's own 128 MiB. A 512 MB instance holds 3 pi runs, 2 codex runs or 1 claude-agent run at once; before, it admitted 5 runs of any harness, and one claude-agent run there killed the container, server included.
- A start that doesn't fit in what is left is the same `429 rate_limited` with `retry-after` as before, its message naming the harness and the memory it needs and has free (`details.harness`, `needs_mb`, `free_mb`). There is still no queue, and a message to a run already going is never refused for a place. A run's process the next server adopts after a restart holds its harness's memory there; a run whose harness never fits that server fails with why instead of starting again.
- A harness whose single run can never fit (claude-agent on a host under 416 MB) is unavailable: its capabilities entry says why, a save warns, and its runs are `409 agent_not_runnable` with that reason, not a 429 to retry. pi always has one place.
- `--max-runs N` and `AGENTRUN_MAX_RUNS` still cap the count, and both limits apply. By default the count is as many pi runs as fit.
- Capabilities' `limits.max_concurrent_runs` is pi's count (the smallest run, so the most at once). Each `harnesses` entry adds `run_memory_mib` and its own `max_concurrent_runs`, marked `harness/2` in the served document.
