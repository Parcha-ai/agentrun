---
packages: @parcha/agentrun-codex
kind: feature
---
A Codex session can turn on Codex's own web search, live: `codexAdapter({ webSearch: "live" })` sets `web_search = "live"` in Codex's config, and the session's model proxy admits exactly the hosted `web_search` tool the pinned binary then sends (and a `tool_choice` naming it) and refuses any other web search tool; every other hosted tool is dropped or refused as before. Each search a response ran (its `tool_usage.web_search.num_requests`) is added to the response's price at OpenAI's $10 per 1,000 calls, so it counts in the session's cost and the host's budget; a model with no known search price, or a response that does not say how many searches it ran, is booked at an unknown cost. A request that offers web search has no input bound (a search's content is billed as input), so a cap that holds each request's worst case treats its input as unknown. Off by default, and off is unchanged. `CodexWebSearch` is the option's type.
