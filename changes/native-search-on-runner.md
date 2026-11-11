---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A web_search that resolves to the model provider's own search works again on the runner (#2458). It used to answer "web_search has no model to search on" every time:
- A pi run's own web_search on an Anthropic or OpenAI model. That is what `auto` picks for pi, and `native` too. Each search now goes through the run's model proxy with the provider's search tool, and its searches are booked at the provider's price on top of its tokens.
- A learned workflow's call node whose web_search resolves native, on any harness.
- A claude-agent or codex run with web_search set to native. Its own search (Claude's WebSearch, Codex's live search) was never switched on, because the run's tool choices never reached the adapter.

Each run's search uses that run's own model route, never one shared by the whole process. Hand-written workflow agents were not affected: their web_search never resolves native. Both harness packages now export their `withWebSearches` price wrapper.
