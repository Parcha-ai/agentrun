---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: breaking
---
The old manual way of taking Composio's events is removed: a webhook trigger with `signature: "composio"`, a webhook subscription made by hand on Composio, and Composio's secret pasted in with Set secret. A Composio trigger (Triggers → New app trigger, source kind `composio`) is now the one way: it makes and keeps the subscription itself. A webhook trigger made the old way stops firing; delete it and make an app trigger for the same event instead.
- A webhook trigger's create, or a change to it, with `signature: "composio"` is refused `422` under `source.signature`, in words that point to Triggers → New app trigger. `features.triggers.webhook.signatures` is `["standard", "github"]`.
- `POST /v2/triggers/{id}/secret` takes no body: any body, `{}` too, is refused `422` before the secret changes, and the new secret is always made here. The console sends none.
- `features.triggers.public_url` on `GET /v2/capabilities` says whether the server has a public address (`AGENTRUN_PUBLIC_URL`), never the address. Without one the console keeps New app trigger in sight but off, with the line "App triggers need this server's public address: set AGENTRUN_PUBLIC_URL and restart."; the create's `409 composio_no_public_url` stays.
- A Composio subscription at another address (`409 composio_subscription_elsewhere`) can now only be another server's or a tool of the owner's. The refusal and the console's question before Move it here say what a move stops: "Composio sends this project's events to <url> now. Moving them here stops them arriving there: anything listening at <url> (another AgentRun server, or a tool of yours) gets no more events."
- The README's Composio quickstart, the tutorial docs/tutorials/composio.md and the server's reference teach the app trigger alone.
