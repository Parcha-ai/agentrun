---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: breaking
---
`GET /capabilities` no longer has `features.harness_keys.kept`, and its answer is now the same for every caller. The console offers Settings → Harness keys wherever the server serves the keys' routes (`features.harness_keys.routes`), as it does Tool keys, so the tab now shows on a server started with no plan-billed recipe too, empty there. The page's own `GET /settings/harness-keys`, which only the owner's session can read, still lists each id whose recipe the server no longer names (`named: false`), so its keys can be removed. A client that read `kept` should read that list instead.
