---
packages: @parcha/agentrun-serve
kind: feature
---
`web_search` searches the web on pi with no key, through Exa's public MCP endpoint (`https://mcp.exa.ai/mcp`). Only the query and the number of results leave the server, over IPv4, nothing else from the run. Past Exa's free rate limit the search is a tool error naming the 429 and its Retry-After; a search ends at 60 s. Keyless Exa is the default for a harness with no native search when no search key is saved; turning it off comes with Settings → Tools, as the provider pick for each capability. The Parallel key no longer lists `web_search` in what it unlocks. claude-agent and codex do not bind `web_search` yet.
