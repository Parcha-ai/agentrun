---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) serves `DELETE /v2/runs/{id}` for a run of an agent an inline run made (`external`): a backend erasing one user's runs of a shared external agent purges each run, where deleting the agent would take every user's runs. The purge is the full server's: `204`, and `204` again once purged; `409 run_not_final` while it or a run made from it is live; every other route of it `410 purged`; its cost kept in every total. A run of an agent made here stays refused there with the profile's `404`, as before.
