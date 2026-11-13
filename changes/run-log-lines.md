---
packages: @parcha/agentrun-serve
kind: fix
---
The server's log prints `event=run_started` (run, agent, kind) when a run is first claimed and `event=run_ended` (run, agent, status, cost_usd) when it ends, again after the run engine's removal dropped them. Each run has one of each, a reclaim after a lost runner prints no second start, and `AGENTRUN_LOG=quiet` keeps them. The runner beside the server writes them to the same stdout; a separate `agentrun-serve runner` process writes them to its own.
