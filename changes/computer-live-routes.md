---
packages: @parcha/agentrun-serve
kind: breaking
---
A run's live view is one family for every computer kind, the browser included. `GET /v2/runs/{id}/computer` (getRunComputer) answers `{state: "live", kind, viewer, hold}`, `{state: "none", kind, hold}` or `{state: "off", hold, why}`; `kind` is `browser`, `desktop` or `phone`, and `hold` says who drives (`agent`, `pending`, `person`). The viewer is under `/v2/runs/{id}/computer/live/`, with the same page, CSP, origin and cookie checks as before. `POST /v2/runs/{id}/computer/hand-back` (handBackRunComputer) answers the agent's ask, which a run shows as `pending: {kind: "computer", computer, instruction, completion_condition, asked_at, expires_at}`; `run.needs_input` says `pending.kind: "computer"`. `GET /runs/{id}/browser`, `/browser/hand-back`, `/browser/live/` and `pending.kind: "browser"` are gone, with no alias.
