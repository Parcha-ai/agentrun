---
packages: @parcha/agentrun-computer
kind: docs
---
PROVIDERS.md's Fly section says how to name the Fly app the machines live in. Fly app names are global, so use `agentrun-computers-<org slug>` (the API call and the `fly apps create` line are given). It also says that Fly answers 403, not 404, for an app held in an org the token can't see.
