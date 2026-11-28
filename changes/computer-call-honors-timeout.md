---
packages: @parcha/agentrun-serve
kind: fix
---
`POST /v2/runs/{run_id}/computer/call` runs an `exec.run` or a `process.wait` for its own `timeoutMs` plus 15 seconds, at most 30 minutes. Before, every call was cut at 120 seconds whatever its `timeoutMs` said, and a command given longer died with a `timeout` answer. Any other call, or one with no `timeoutMs`, still runs at most 120 seconds. For longer work, or behind a proxy that cuts a long request sooner, start it with `process.start` and read it with `process.wait` calls of a shorter `timeoutMs`.
