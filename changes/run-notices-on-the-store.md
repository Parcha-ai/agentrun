---
packages: @parcha/agentrun-serve
kind: breaking
---
The outbound webhook keeps everything in the store, and refuses a private address: a webhook set on an earlier build (`DIR/webhook.json`) is not read, and its pending messages (`DIR/webhook-outbox.json`) are not sent. To upgrade, let pending webhooks drain, then set the webhook again with `PUT /v2/settings/webhook` and give your receiver the new secret it shows once. A receiver on this machine or a private network is refused unless the operator sets `AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1` where the server starts.
Its URL is a store setting, its secret is sealed in `trigger_settings`, and its messages, their tries and the run notices it told are in the channel tables, so a server on Postgres sends it too (Postgres migration 0003, SQLite schema version 6). The server says once at its start when an earlier build's file is left (`condition=webhook_left_over`).
The run notices follow the store's run-change feed, so a run that starts and ends between two reads, or whose end cannot be read for a while, is still told once.
A URL is refused at its `PUT` when it is on a private network or this machine, by address or by what its name resolves to, and each try dials the address it checked. A `PUT` that changes the URL makes a new secret and shows it once (the same URL keeps its secret); `GET /v2/settings/webhook` and the log show the URL's origin and its last four characters, never the whole URL.
A run that asked a question sends `run.needs_input` once for it: the answer's take clears the run's waiting summary for a reopened run that parked on a question too, and a wait's `webhook-id` comes from its ask, never from the row the run shows last.
