---
packages: @parcha/agentrun-serve
kind: fix
---
A gateway model named with its version's separators written the other way from pi-ai's catalog (the broker's
`gpt-5-4-mini` for the catalog's `gpt-5.4-mini`, `claude-haiku-4.5` for `claude-haiku-4-5`) is priced by the catalog's
entry, so a capped run on it runs instead of being refused before its first request ("has no price here"). Only when that
form lists one price across its entries: different prices leave the model unpriced. The exact id wins, a price the host
gives (`AGENT_MODEL_PRICE`) wins over the catalog, and the id sent to the gateway never changes.
