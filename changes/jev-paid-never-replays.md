---
packages: @parcha/agentrun-jev
kind: breaking
---
**`createJevRunner` never re-sends a paid request unless you ask it to**
- A public default that could re-send a paid request was the bug. A request that was sent may have been answered and billed, so the runner no longer retries a 408, a 5xx or a connection lost after sending. It sends the request once and fails with the new `JevError` code `outcome_unknown` (with the HTTP `status` when there is one), at an unknown cost.
- It still retries a request that provably never reached Jev (no DNS answer, no connection, no TLS handshake), and a 429 with `Retry-After`. A 429 without `Retry-After` is now an `http` error at once.
- Who breaks: a host that counted on the runner retrying 5xx responses, lost connections or 429s with no `Retry-After`. What to do: hosts that want the old retries opt in with `createJevRunner({ retryAfterSend: true })`, knowing such a retry can re-send a request Jev answered and billed. A host that switches on `JevError.code` handles `outcome_unknown`, for example by sending the case to a person rather than asking again.
