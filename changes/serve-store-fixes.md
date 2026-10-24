---
packages: @parcha/agentrun-serve
kind: fix
---
`PUT /v2/agents/{id}/definition` with `If-Match` is compared inside the store's commit, so of two edits that read the same revision exactly one lands and the other answers `412`, where both could land, the second on top of the first. A run's process loads only the model tiers its revision uses, so a workflow of fast nodes runs with `AGENT_MODEL_FAST` and no `AGENT_MODEL`. A run's process no longer gets the server's token: `AGENTRUN_TOKEN`, `AGENTRUN_API_KEY` and any variable holding the token are left out of its environment, and model keys and the `AGENT_MODEL` variables still reach it.
