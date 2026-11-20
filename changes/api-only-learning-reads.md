---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) serves an agent's learning reads with its token, so a backend that launches learning runs can read what its agents learned: `GET /v2/agents/{agent_id}/learning/loop`, `GET /v2/agents/{agent_id}/learning/promotions`, `GET /v2/agents/{agent_id}/learning/cost` and `GET /v2/runs/{run_id}/learning`, each cut of the host's secrets as the console's reads are. Every learning write (corrections, approvals, retires, replays) and every read of the learning's own text (the learning view, corrections, files, log, revisions, audits, a run's diff) is still refused there.
