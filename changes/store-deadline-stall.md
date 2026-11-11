---
packages: @parcha/agentrun-serve
kind: fix
---
`POST /v2/agents`, and every other write, no longer answers 500 when the server's own process is held up while the write is open. On SQLite a write's 10 s deadline is a timer on the server's event loop. When other work in the process held that loop past the deadline (a harness's pinned CLI hashed, or its `--version` run, synchronously, as the harness check does), the timer fired after the write's statements had already been answered, and the write was rolled back as if it were slow. The deadline now counts only time the process could run, on the monotonic clock: every hold of the process while the write is open is given back, whether it ended before the deadline or past it, and the host's clock set forward or back is never counted. A write that really stays open past its deadline is rolled back as before, and the request is answered `409 home_busy` (retryable), as a store busy past its wait is, never 500. An MCP client's tool call (such as `agents_create`) is refused the same `home_busy` instead of `internal`.
Upgrading: nothing to do.
