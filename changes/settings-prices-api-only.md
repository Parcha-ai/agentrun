---
packages: @parcha/agentrun-serve
kind: fix
---
An API-only server (`AGENTRUN_API_ONLY=1`) serves `GET /v2/settings/prices` with its token, so the backend in front of it can read the prices its meters use and bound a run's budget in the server's figures before launch. A request without the token is still 401. The read returns this server's settings; a runner started separately meters at the prices in its own environment.
