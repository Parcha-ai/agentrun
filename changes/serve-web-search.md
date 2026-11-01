---
packages: @parcha/agentrun-serve
kind: feature
---
A revision may name `web_search` on pi, `claude-agent` and `codex`: `{query, n?}` searched through Parallel's Search API (its `fast` mode, about $0.001 a search), answering `{query, results: [{url, title, published?, snippet}]}`, or `{error}` when Parallel gives no answer. The query is cut at 200 characters, `n` is 1 to 25 (10 by default), and a result's excerpts become one snippet of at most 500 characters. It needs `PARALLEL_API_KEY`: without it, capabilities show the tool `missing`, a save warns and a run is refused (409). An agentic run naming `web_fetch` or `web_search` gets the Parallel key on its decision descriptor, in memory only, and a 401 or 403 to either tool stops Parallel for both for the rest of the run.
