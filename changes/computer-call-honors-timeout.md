---
packages: @parcha/agentrun-serve
kind: fix
---
`POST /v2/runs/{run_id}/computer/call` runs an `exec.run` or a `process.wait` for its own `timeoutMs` plus 15 seconds, at most 30 minutes. Before, every call was cut at 120 seconds whatever its `timeoutMs` said, and a command given longer died with a `timeout` answer. Any other call, or one with no `timeoutMs`, still runs at most 120 seconds. For longer work, or behind a proxy that cuts a long request sooner, start it with `process.start` and read it with `process.wait` calls of a shorter `timeoutMs`.

A call still running when the run ends (a cancel, a stop, the agent finishing) is cut then and answers `aborted` with "the run ended before the call did", so ending a run never waits out a long call. A stop that keeps a held computer still answers the owner's calls until the hold ends.
