---
packages: @parcha/agentrun-serve
kind: feature
---
A revision may name `web_fetch` on pi, `claude-agent` and `codex`: `fetch_page`'s Page plus `via`, `"parallel"` or `"direct"`. With `PARALLEL_API_KEY` set it reads the page through Parallel's extract (about $0.001 a URL); without the key, or when Parallel lists the URL in its errors, answers 5xx or times out, it is `fetch_page`'s guarded direct fetch. A URL the public-host guard refuses is never sent to Parallel, and a 401 or 403 stops Parallel for the rest of the run. An agentic run gets the Parallel key, on its decision descriptor and in memory only, when its revision names `web_fetch`; `fetch_page` is unchanged and never calls Parallel.
