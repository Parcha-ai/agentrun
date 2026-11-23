---
packages: @parcha/agentrun-serve
kind: fix
---
An API-only server (`AGENTRUN_API_ONLY=1`) now purges a run of an agent made here (a deployed agent's, say) with its token, as it already did a run of an agent another system owns. Before, `DELETE /v2/runs/{id}` of such a run was the profile's `404`, though the same token could archive and delete the whole agent, which purges every run of it. The purge is the full server's: `204`, and `204` again once purged; `409 run_not_final` while it or a run made from it is live; every other route of it `410 purged`; its cost kept in every total; the agent and its other runs kept.
