---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/wrapped` is 403 on a server that has an API key made in the console for an app (Settings → AgentRun API keys), as on one that takes a second API token: the key's holder no longer reads the machine user's year. Once the keys are revoked, the owner reads it again.
