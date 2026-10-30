---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose launch takes the server down no longer takes it down again at every start. serve writes a launch mark in the run's directory before it spawns the run's process, and removes it once that process serves or exits. A start that finds the mark fails the run once, with `run_failed` and `error.details.reason` `server_lost_at_launch`, instead of launching it again. Before, a spawn that aborted serve itself (as on macOS) was repeated by the next start's recovery, so serve went down at every start until the operator removed the run. `RunError.details` is this server's own field, marked `x-agentrun-serve` in the served OpenAPI document; the vendored contract is unchanged. A run whose process came up and then died still opens again as before.
