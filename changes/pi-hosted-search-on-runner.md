---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A web_search that resolves to the model provider's own search works again on the runner for pi (#2458). It used to answer "web_search has no model to search on" every time:
- A pi run's own web_search on an Anthropic or OpenAI model. That is what `auto` picks for pi, and `native` too. Each search now goes through the run's model proxy with the provider's search tool, and its searches are booked at the provider's price on top of its tokens.
- A learned workflow's call node whose web_search resolves native, on any harness.

Each run's search uses that run's own model route, never one shared by the whole process. Hand-written workflow agents were not affected: their web_search never resolves native. Both harness packages now export their `withWebSearches` price wrapper, and the Codex one its `webSearchUsd`. A claude-agent or codex run's own search is not switched on by this change.

A capped run holds a hosted search's fees with its tokens before the request is sent, at the most searches the request allows, so the fees can't pass the cap. The kernel's model proxy takes a policy's `feeMaxUsd(body)` and holds it as the request's `feeUsd`; a fee it can't bound leaves the request unmeasured. The proxy also hands `usageOf` the sent body as a second argument, so a pi request on OpenAI's Responses that offered no search reads 0 searches from its body, even when its answer names a search call.
