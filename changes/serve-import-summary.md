---
packages: @parcha/agentrun-serve
kind: feature
---
`import` brings in every local session with its analytics. Each imported run keeps what its session used, a run its source did not price gets a catalog estimate, and the import ends with a summary of every session it found (the ones it imported before included) and the address to open the console at. So does `--dry-run`, from what it would import:

```
Found 1,284 sessions  Claude Code 911 · Codex 301 · pi 72
Imported into 37 agents (one per project)
+ 41.2M tokens (78% cached) · 2,310 h of agent time
+ Busiest hour: 02:00 · top tool: Bash (31%)
```

- What each run keeps: the store's metrics, which are its tokens, model requests, models, tool calls with their errors, the effort or thinking level it ran at, and its time at work (the gaps between the session's records, each capped at 15 minutes). The run's transcript carries each request's own tokens and model, so its timeline and its metrics agree.
- Claude Code's usage is read once per message, though the CLI repeats it on every record of a message. Its own `<synthetic>` turns are an API error, imported as a request that failed, or a line of its own, which is no request and never the person's.
- Codex's usage comes from its `token_usage_record`s, or from its `token_count` events in a rollout without them, with OpenAI's cached tokens taken out of the input. A Codex call fails when its output or its completed item says so.
- pi's usage is read as pi wrote it.
- A request whose source gave no counts stays unmetered, never 0 tokens.
- The estimate covers every Codex session, a Claude Code session using a model the CLI could not price, and a pi session with an unpriced request. It is each request at its own provider's catalog list price for its model, in the metrics' `costUsdEst` with `costBasis: "catalog"`, and the run's cost stays unknown. A provider the catalog does not list for that model, or a request whose tokens are unknown, leaves the estimate unknown, never $0. A provider's $0 is $0. A cost the source recorded is kept, with no estimate.
- The summary: the cached share is cache reads over all input, agent time is the runs' time at work, the busiest hour is the local hour of day with the most model requests, and the top tool is the one with the most calls. A figure with no data behind it reads `unknown`. The address to open the console at is the server's public one when `AGENTRUN_PUBLIC_URL` is set, else this machine's at the port the server listens on, which `import` now takes as `--port`.
