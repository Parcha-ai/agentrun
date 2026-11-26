---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
A run whose start fails before its own process is up (a store read, the server's settings or its keys) no longer holds a stop or a command sent to it: each now ends at once, saying the run's process is not running, where it used to wait with no end. An agent's tool that the server denies no longer shows `ceiling` on GET /v2/agents/{agent_id}: its `resolved` says `unavailable: denied`, and the deny, not the setting under it, is why nothing runs.
