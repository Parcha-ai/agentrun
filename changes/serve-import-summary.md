---
packages: @parcha/agentrun-serve
kind: feature
---
`import` ends with a summary of every session it found, the ones it imported before included, and so does `--dry-run`, from what it would import:

```
Found 1,284 sessions  Claude Code 911 · Codex 301 · pi 72
Imported into 37 agents (one per project)
+ 41.2M tokens (78% cached) · 2,310 h of agent time
+ Busiest hour: 02:00 · top tool: Bash (31%)
Open http://127.0.0.1:7340/
```

The cached share is cache reads over all input. Agent time is the runs' time at work. The busiest hour is the local hour of day with the most model requests, and the top tool is the one with the most calls. A figure with no data behind it reads `unknown`. The address is the server's own, from `--listen` and `--port` (which `import` now takes as the server does) or `AGENTRUN_PUBLIC_URL`. An imported run whose source did not price it (every Codex session, a Claude Code session using a model the CLI could not price, a pi session with an unpriced request) gets an estimate at pi-ai's catalog list prices, by each request's own model and provider, in its metrics' `costUsdEst` with `costBasis: "catalog"`. Its cost stays unknown. A model the catalog does not list, or a request whose tokens are unknown, leaves the estimate unknown, never $0. A model listed at $0 is $0. A cost the source recorded is kept, with no estimate.
