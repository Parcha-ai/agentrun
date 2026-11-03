---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
A run's `run.ended` webhook is no longer lost, or sent twice under two ids, across a crash or a refused write. The server now chooses a run's end time once and saves it with the run before writing the end anywhere; the agent store's `ended_at` and the message's `webhook-id` both come from it (`carryBack` takes it as `endedAt`, an ISO time in UTC; with none it stamps now, as before). `run.ended` is queued only once the agent store has the end, and recorded as queued only once the webhook outbox holds it on disk, so a server killed in between leaves it for the next one, which queues it at its start under the same id. Behaviour change: while the agent store refuses a run's end, `run.ended` waits until the end is stored (a later try or the next server), where it used to go out at once; a receiver that reads the run back on its message reads it ended.
