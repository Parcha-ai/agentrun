---
packages: @parcha/agentrun-serve
kind: feature
---
`web_fetch` on `auto` (the default) now reads through Parallel's extract on any server that holds a Parallel key (`PARALLEL_API_KEY`, set or saved). Parallel gets each URL, with the run's session id and model id, and bills each page to the server's Parallel key. The guarded direct fetch is behind it. Before, `auto` on such a server was the direct fetch. A server with no Parallel key is unchanged (keyless Firecrawl). To keep every URL on the server, pick `kernel` for `web_fetch` (`PUT /v2/settings/tools` or an agent's `tool_settings`). GET /capabilities' `why` says which one a run gets.
- Both tools' `auto` order is one table, `DEFAULT_WEB_ORDER`, exported with `autoWeb`. Swapping its ids puts another provider first.
