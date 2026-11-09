---
packages: @parcha/agentrun-serve
kind: feature
---
A run's live view is also served as the computer family, one for every computer kind, beside the browser's own routes. `GET /v2/runs/{id}/computer` (getRunComputer) answers `{state: "live", kind, viewer, hold}`, `{state: "none", kind, hold}` or `{state: "off", hold, why}`; `kind` is `browser`, `desktop` or `phone` (an open viewer's own, as its row in the store says it), and `hold` says who drives (`agent`, `pending`, `person`). Its viewer is under `/v2/runs/{id}/computer/live/`, with the same page, CSP, origin and cookie checks as `/browser/live/`, served by the same code. `GET /runs/{id}/browser`, `/browser/hand-back` and `/browser/live/` answer as before.
