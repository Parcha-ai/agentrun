---
packages: @parcha/agentrun-serve
kind: fix
---
The outbound webhook keeps everything in the one store: its URL in settings, its secret sealed in `trigger_settings`, its messages, their tries and the run notices it told in the channel tables. It no longer writes `webhook.json` or `webhook-outbox.json`, and a server on Postgres sends it too. The run notices follow the store's run-change feed, so a run that starts and ends between two reads, or whose end cannot be read for a while, is still told once, and a start takes the feed's head in one read.
A webhook set on an earlier build is not read: the server says so once at its start (`webhook_left_over`); set it again with `PUT /v2/settings/webhook`, which shows a new secret.
The outbound webhook sends to no private network or this machine: such a URL is refused at its `PUT`, by address or by what its name resolves to, and each try dials the address it checked, so a name that resolves elsewhere in between reaches nothing; an operator who wants it sets `AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1`. A `PUT` that changes the URL makes a new secret and shows it once (the same URL keeps its secret), and `GET /v2/settings/webhook` and the log show the URL's origin and last four characters, never the whole URL.
