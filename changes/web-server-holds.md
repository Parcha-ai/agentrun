---
packages: @parcha/agentrun-web, @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A keyless provider's limit now holds it for the whole server, not only the run that met it. Keyless Firecrawl and keyless Exa run on the host's free allowance, so when one run is rate-limited or out of quota, the next run should not pay another refusal to learn it.

- `createWeb` takes `holds` (new `Hold`: provider, tool `search`, `fetch` or `key`, kind and end). Each hold seeds the matching breaker the first time it is used: the Web's own breakers and the breakers a call brings alike. A hold that has already ended is ignored. `onHold` receives each limit that leaves a breaker holding.
- serve keeps the keyless holds in memory (`web-holds.ts`), with the server as the only writer. A run's own process reports each hold over its channel to the runner. A new run gets the current holds in its spawn environment (`AGENTRUN_SERVE_WEB_HOLDS`), which carries hold data only, never a key. The run's start line and its first call already see them. Each hold is logged as `event=web_provider_held`.
- A hold whose limit names no end is kept for an hour (`ENDLESS_HOLD_MS`). A restart forgets every hold, so the first run after a restart pays at most one refusal to learn it again. Keyed providers' holds stay with the run.
- `GET /capabilities` adds `held` to `web_search` and `web_fetch`. It is read live on each answer and lists each hold on a provider the tool resolves to, with its kind, its end and words such as `rate-limited until 12:01 UTC`. When nothing holds the tool, the field is absent.

Known limit: a runner in its own process (`agentrun-serve runner`) keeps its runs' holds in its own memory, so that server's `/capabilities` does not see them.
