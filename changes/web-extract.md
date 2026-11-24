---
packages: @parcha/agentrun-web, @parcha/agentrun-serve
kind: feature
---
`@parcha/agentrun-web` is new: the machinery behind `web_search` and `web_fetch`, moved out of `@parcha/agentrun-serve` with no change to what a model is sent or told. It holds the providers (Parallel, keyless Firecrawl, keyless Exa, a hosted search given as a function, and the direct fetch), a breaker per provider, the per-run page cache read in parts, and Parallel's prices. It imports no server, browser or vendor SDK code. The provider order, keys, public-host guard, run cap and refusal words come in through `WebConfig`. `createWeb(config)` answers a search or a fetch together with a receipt of the providers tried and the fees sent. `@parcha/agentrun-web/text-urls` exports the link finder alone. `@parcha/agentrun-serve` now depends on it and passes pi-browser's `publicFetch` as the guard.
