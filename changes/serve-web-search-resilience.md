---
packages: @parcha/agentrun-serve
kind: feature
---
`web_search`'s default, `auto`, uses your Parallel key when the server has one (`PARALLEL_API_KEY`, or a key saved on
Tool keys), and bills it. That applies wherever the run has no native search on auto: pi behind a gateway or on a model
with no hosted search, codex behind a gateway or under a spend cap, a workflow, and claude-agent. On claude-agent, `auto`
now skips Claude's own search, which is an explicit `native` pick (refused under a spend cap, as before). Otherwise it is
keyless Exa. The order is the pick, then native (not on claude-agent), then Parallel, then keyless Exa. A pick of
`native` stays native only, a pick of `exa-keyless` stays keyless Exa, and `web_fetch` stays the kernel's fetch by
default.
Capabilities' `web_search` and `web_fetch` now say `why` beside `resolves`, one sentence per harness.
Keyless Exa is also sturdier:
- It is dialled over IPv4 alone, so a host whose default route is IPv6 no longer gets Exa's 403.
- Past Exa's free limit (a 429, or the rate-limited notice Exa sends inside a 200), the search is tried once more after
  a short jittered wait, then answers "Free web search is rate-limited right now. Try again in a minute, or add a
  Parallel key in Settings → Tool keys to search with a key."
- Exa's own failure text reaches the model as its first sentence only, quoted. Exa's instructions to update an MCP URL
  never do.
