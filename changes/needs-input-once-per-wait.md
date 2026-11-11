---
packages: @parcha/agentrun-serve
kind: breaking
---
The webhook outbox file moves to version 4; an outbox from an earlier server is discarded at start, so deliveries still pending in it are not sent; let pending webhooks drain before upgrading.

With it, the outbound webhook sends `run.needs_input` once per wait. Before, a run that parked on a question could send it a second time, under a new `webhook-id`, right after the person answered. Each wait's `webhook-id` now comes from its own ask (a question's waiting row, an approval's call, a budget pause's time, a hand-over's ask), the ledger keeps every wait it told each run of, and the answer to a parked question clears the run's "Waiting for your reply" summary in the commit that takes it.
