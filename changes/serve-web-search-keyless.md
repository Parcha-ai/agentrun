---
packages: @parcha/agentrun-serve
kind: feature
---
`web_search` searches the web on pi with no key, through Exa's public MCP endpoint (`https://mcp.exa.ai/mcp`). Only the query and the number of results leave the server, over IPv4, nothing else from the run. Past Exa's free rate limit the search is a tool error naming the 429 and its Retry-After; a search ends at 60 s. `AGENTRUN_WEB_SEARCH_KEYLESS=off` turns it off: the tool answers that it is off and sends nothing. The Parallel key no longer lists `web_search` in what it unlocks. claude-agent and codex do not bind `web_search` yet.
