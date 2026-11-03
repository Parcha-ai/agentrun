---
packages: @parcha/agentrun-serve
kind: fix
---
An unavailable `claude-agent` or `codex` now says when a restart is part of the fix. The server checks each harness's package and pins once, at its start, so a harness installed after it, or put back on its pinned build, stays unavailable until AgentRun restarts. Its reason in `GET /v2/capabilities` (and in a save's warning or a run's `409`) now ends with `install it, then restart AgentRun to pick it up`, or `install the pinned build, then restart AgentRun`. A reason a setting fixes, such as a missing model key, is unchanged.
