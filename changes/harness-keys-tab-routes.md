---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: breaking
---
`GET /capabilities` no longer has `features.harness_keys.kept`, and its `features.harness_keys` is now the same for every caller. The console offers Settings → Harness keys wherever the server serves the keys' routes (`features.harness_keys.routes`), as it does Tool keys, so the tab now shows on a server started with no plan-billed recipe too, empty there. `GET /settings/harness-keys`, which any authenticated caller can read (saving and removing a key still take the owner's session), still lists each id whose recipe the server no longer names (`named: false`), so its keys can be removed. A client that read `kept` should read that list instead.
