---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A pi run whose `web_search` resolves to its model provider's own hosted search (Anthropic's or OpenAI's) searches again. On the runner every such search answered "web_search has no model to search on in this run"; now the search is one request through the run's session proxy, booked once on the run's ledger at its tokens and the provider's per-search fee, and the run's cost holds it once. `withWebSearches`, the price with each search a response reports added at its fee, is exported from the Claude and Codex harness packages.
