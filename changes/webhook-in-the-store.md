---
packages: @parcha/agentrun-serve
kind: fix
---
The outbound webhook keeps everything in the one store: its URL in settings, its secret sealed in `trigger_settings`, its messages, their tries and the run notices it told in the channel tables. It no longer writes `webhook.json` or `webhook-outbox.json`, and a server on Postgres sends it too. The run notices follow the store's run-change feed, so a run that starts and ends between two reads, or whose end cannot be read for a while, is still told once, and a start takes the feed's head in one read.
A webhook set on an earlier build is not read: the server says so once at its start (`webhook_left_over`); set it again with `PUT /v2/settings/webhook`, which shows a new secret.
