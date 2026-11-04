---
packages: @parcha/agentrun-serve
kind: fix
---
`POST /v2/runs/{id}/messages` no longer answers `409 home_busy` for a message it has already taken. Its answer read the run's stored row after the message went in. So while another connection held the agent store, a message that ran was answered `home_busy`, and a client that retried sent it twice. The answer's `status` and `state` now come from the run itself. `POST /v2/agents/{id}/runs` had the same shape: its answer read the stored row after the run was written and its first message counted. A busy store answered `409 home_busy` for a run that ran, and a retry without an Idempotency-Key started a second one. A run's start now answers from the run itself, and so do a stop and a cancel, which read the store after they took effect only for their status.
