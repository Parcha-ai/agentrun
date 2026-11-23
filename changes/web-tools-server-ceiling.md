---
packages: @parcha/agentrun-serve
kind: breaking
---
Who breaks: an agent whose own `tool_settings` pick `firecrawl-keyless`, `exa-keyless` or `auto` for `web_search` or `web_fetch` on a server set to `native` for `web_search` or `kernel` for `web_fetch`. The server's setting is now a ceiling the agent's pick cannot raise: its URLs and queries stay on the server, and where the harness has no native search its `web_search` is unavailable, so its runs are refused. To search through a keyless service again, set the server's `web_search` to `auto`, `firecrawl-keyless` or `exa-keyless` (`PUT /v2/settings/tools`), or pick `parallel` for the agent where the server holds a Parallel key.
- Capabilities' `why` says when an agent's pick is kept on the server ("kept on the server: the server's setting is kernel"), and a run made before the setting follows it at its next launch.
- A page `web_fetch` read directly because keyless Firecrawl gave none now says why in a few words, in `fallback` (such as `firecrawl quota spent`, `firecrawl rate-limited` or `firecrawl page 404`), never the URL.
- A search that turns Firecrawl off for the run while keyless Exa waits out a rate limit now says both: Firecrawl is not asked again, and search is busy for the seconds left of Exa's wait.
