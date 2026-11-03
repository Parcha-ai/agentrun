---
packages: @parcha/agentrun-serve
kind: fix
---
`POST /v2/runs/{id}/messages` to a run that waits (stopped, or between turns) no longer answers `409 home_busy` while another connection holds the agent store. The message read the run's harness from the store first, to choose between a steer and a follow-up. Its answer then read the run's stored row, so it could also be answered `home_busy` after it was already taken. Now the harness is read only for a message to a working run, whose mode it decides, and the answer's `status` and `state` come from the run itself. `POST /v2/agents/{id}/runs` had the same shape. Its answer read the stored row after the run was written and its first message counted, so a busy store answered `409 home_busy` for a run that ran, and a retry without an Idempotency-Key started a second one. A run's start now answers from the run itself, and so do a stop and a cancel, which read the store after they took effect only for their status.
