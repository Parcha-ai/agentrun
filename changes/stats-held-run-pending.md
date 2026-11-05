---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
GET /stats counts a run that has just ended as ended, as GET /runs/{id} already says, never as running or as a run of unknown cost. A run reads ended as soon as its turn ends, and its end, with its metrics, reaches the agent store after its process has let it go. Before, /stats counted it meanwhile as a running run: status unknown, cost unknown, effort unset, no tokens. Now, while its end is on its way, it is counted completed (or failed, or stopped) in the run counts and the totals, and its tokens, cost and effort are left out until the store has them, when it counts whole. `AgentStoreReader.analytics` takes `pending`, the runs whose end the caller holds, by the state their end will have.
