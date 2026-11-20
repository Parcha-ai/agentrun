---
packages: @parcha/agentrun-serve
kind: fix
---
A server whose runners all refuse to claim now says so: a start or a message answers 503 `runner_refused` in the runner's words, a queued run fails with that code, `GET /v2/capabilities` has `runner_refused`, and `/v2/health` answers 200 `degraded`. Postgres migration 0020 renames `runner_relays` to `runners`, and SQLite recreates it at the server's open. Start this build's server before its runners.
