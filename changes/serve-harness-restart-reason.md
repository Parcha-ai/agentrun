---
packages: @parcha/agentrun-serve
kind: fix
---
An unavailable `claude-agent` or `codex` now says when a restart is part of the fix. The server checks each harness's package and pins once, at its start, so a harness installed after it, or put back on its pinned build, stays unavailable until AgentRun restarts. Its reason in `GET /v2/capabilities` (and in a save's warning or a run's `409`) now ends with `once it is installed, restart AgentRun to pick it up`, or `once the pinned build is installed, restart AgentRun`. Run from npx, a reason whose install line is already the npx line that restarts the server with what is missing is unchanged, as is a reason a setting fixes, such as a missing model key.
