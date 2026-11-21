---
packages: @parcha/agentrun-serve
kind: fix
---
Keep delayed CLI hook retries in source order. An older queued submit or session ending cannot
interrupt a newer prompt. When earlier dialogue cannot be ordered safely, retain it privately and
mark the capture incomplete instead of presenting it as prior context.

Bound newly captured prompts, answers and dialogue to the server's text and event limits, including
after secret redaction. Truncated evidence remains explicitly incomplete and can be uploaded instead
of retrying an oversized request indefinitely. Already frozen historical requests remain unchanged
because an uncertain earlier upload may have committed their immutable payloads.

Serialize session journals with the existing token-fenced ownership lock. Concurrent recovery of a
dead owner cannot remove a new owner's lock. Legacy empty or PID-only locks remain pending rather
than being removed on age alone; remove such a lock only after confirming no hook or retry process
still owns that journal.

A pending local disconnect no longer advertises learning as ready while hook removal or remote
revocation is blocked. The connector withholds its readiness proof until the connection is active.
