---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent, @parcha/agentrun-pi
kind: breaking
---
A workflow run's graph, once the run has ended, and the server's reads at the run's end (`workflowCarry` and `readWorkflowRun` of its outcome) now read the run's database lock-free, as every other server read does. They make no -wal or -shm file beside it, never wait on a lock, and never remove a WAL that holds commits. `GET /runs/{run_id}/graph` drops its `stale` field. The view it marked (the last whole view, or the live view, shown while the run's store was busy) can no longer happen, since a lock-free read never meets a busy store. The console no longer reads the field. pi-durable-agent's `readWorkflowRun(run, { unlocked })` and `workflowCarry(run, outcome, { unlocked })` take the unlocked read. agentrun-pi exports `withDurableFile`.
