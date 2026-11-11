---
packages: @parcha/agentrun-serve
kind: breaking
---
The outbound webhook (`/v2/settings/webhook`) is in the one store, on SQLite and Postgres alike: its URL and state, its signing secret (sealed under the server's seal key, among the server's sealed settings) and its outbox of messages, attempts and per-run notices. The server no longer reads or writes `DIR/webhook.json` or `DIR/webhook-outbox.json`. A webhook saved before this release must be saved again (`PUT /v2/settings/webhook`, which shows a new secret once): the old files are not read, and their pending messages are not sent. They can be deleted. The webhook's secret is now on a runner's redaction list from the store, as the other sealed settings are, and a secret replaced or removed stays on it across restarts.
