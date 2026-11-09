---
packages: @parcha/agentrun-serve
kind: breaking
---
The server no longer answers `/api/*` (`/api/store`, `/api/agents/{id}`, `/api/runs` and the rest of the old store page's read-only JSON): it read the earlier agent store, which this version no longer keeps. Every path under `/api/` is now the API's 404. Read the same data through `/v2` (`GET /v2/agents`, `GET /v2/agents/{id}`, `GET /v2/runs`), with the token or the console's cookie.
