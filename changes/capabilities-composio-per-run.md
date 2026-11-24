---
packages: @parcha/agentrun-serve
kind: feature
---
Capabilities' `features.mcp_client` says `composio_per_run: true`: a per-run Composio server here takes each run's own Composio account, named in the run's `mcp_auth`. A backend in front of an API-only server (`AGENTRUN_API_ONLY=1`) can learn this from `GET /v2/capabilities`, which that server serves, where before it had to read the API document, which that server refuses. The generated clients carry the field.
