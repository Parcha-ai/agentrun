---
packages: @parcha/agentrun-serve
kind: fix
---
The outbound webhook sends `run.needs_input` once per wait. Before, a run that parked on a question could send it a second time, under a new `webhook-id`, right after the person answered.

Each wait's `webhook-id` now comes from its own ask: a question's waiting row, an approval's call, a budget pause's time, a hand-over's ask. The webhook's ledger also keeps the waits it told each run of before the current one, so the same wait read again sends nothing. The answer to a parked question also clears the run's "Waiting for your reply" summary in the commit that takes it, so the answer's turn no longer reads as a wait. `webhook-outbox.json` stays at version 3 (the earlier waits are an optional field), so an upgraded server keeps and sends the deliveries still pending in it.
