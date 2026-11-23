---
packages: @parcha/agentrun-serve
kind: feature
---
`web_search` and `web_fetch` now default to Firecrawl's public keyless MCP endpoint (`https://mcp.firecrawl.dev/v2/mcp`) where the server holds no Parallel key and the harness has no native search. No key and no header of ours is sent. A Parallel key, when set, still wins.
- `web_search` asks keyless Firecrawl first and keyless Exa behind it. When Firecrawl's free daily limit is spent, or it refuses keyless use, it is off for the rest of the run and Exa answers the same call. With both off, the search says it is unavailable for the rest of the run. A rate limit holds a backend for the wait it names, with no cutoff. A pick of `exa-keyless` is still Exa alone.
- `web_fetch` gains `auto` (the new default) and `firecrawl-keyless`. `auto` is the guarded direct fetch where the server holds a Parallel key, else keyless Firecrawl, with the guarded direct fetch behind it. Firecrawl is sent each URL it reads. A private, loopback, link-local or intranet URL is never sent to Firecrawl or Exa. To keep every URL on the server, pick `kernel` for `web_fetch`.
- `/v2/capabilities` gives `firecrawl-keyless` as a resolution, with a `why` that says what `web_fetch` sends to Firecrawl. The console labels it "Firecrawl keyless".
