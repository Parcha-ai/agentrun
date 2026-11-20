---
packages: @parcha/agentrun-serve
kind: fix
---
An API-only server (`AGENTRUN_API_ONLY=1`) now serves `GET /v2/runs/{run_id}/usage`, a run's usage lines. It answered `404` before, so a backend could read a run and its `cost.usd` but not the lines that make it up. The route reads only that run, takes the server's token, and cuts the host's secrets out of its names as `GET /v2/runs/{run_id}` does. Every other route the profile refused is still refused.
