---
packages: @parcha/agentrun-serve
kind: fix
---
`deploy/compose.yaml` gives each runner container a memory limit, 2 GB by default (`AGENTRUN_RUNNER_MEMORY` in `.env` sets another). A runner claims runs by its memory, which it reads from its container's limit. With no limit, each of the two runners read the whole host's memory and budgeted all of it, so together they could claim twice what the host holds and an out-of-memory kill would take every run on it. Now each holds 1920 MiB of runs (six claude-agent runs or fifteen pi runs at once); the rest wait queued. A runner process also says its budget once at its start, on the line after its ready line: `Runner <name> memory: <N> MiB for runs, each weighed by its harness`.
- Upgrading: on a compose host with less than about 5 GB, set `AGENTRUN_RUNNER_MEMORY` (`1g`, say) so the runners' limits and the server fit.
