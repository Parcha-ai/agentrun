---
packages: @parcha/agentrun-jev
kind: fix
---
The Jev runner honours `Retry-After` on HTTP 429 and 503. It waits the larger of the server's time and its own backoff, never past the request's timeout or its abort signal, and gives up at once when the server asks for longer than is left. A request still rate-limited after its retries ends as before: `JevError` with code `http` and status 429.
