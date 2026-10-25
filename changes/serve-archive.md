---
packages: @parcha/agentrun-serve
kind: feature
---
Archive an agent or a run: `POST /v2/agents/{id}/archive` and `POST /v2/runs/{id}/archive` (and `.../unarchive`), this server's own routes outside the `/v2` contract, listed in `capabilities.features.archive`. An archived agent and its runs, or one archived run, are hidden from `GET /agents`, `GET /runs` and `GET /agents/{id}/runs` (`?archived=true` lists only those), and kept: every read by id still answers, with `archived_at`, and `/usage` still counts them. A new run of an archived agent is `409 agent_not_runnable`; a run already going keeps going. Nothing is deleted, and `DELETE` stays `405`. The page has Archive and Unarchive on an agent's page and a run's page, and Show archived on the agents and on All runs.
