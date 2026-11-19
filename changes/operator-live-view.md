---
packages: @parcha/agentrun-serve
kind: feature
---
An operator's backend can show a run's live view and let its user take over: on an API-only server (`AGENTRUN_API_ONLY=1`), `GET /runs/{id}/computer`, `POST /runs/{id}/computer/take-over` and `POST /runs/{id}/computer/hand-back` take the server's token, and `POST /runs/{id}/computer/viewer` mints a 5-minute link on `AGENTRUN_PUBLIC_URL` that opens that run's live page and socket for the backend's user, until the run ends.
