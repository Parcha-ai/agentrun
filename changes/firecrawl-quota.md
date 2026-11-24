---
packages: @parcha/agentrun-web
kind: fix
---
A search provider whose rate limit names a wait past 15 minutes is now off for that whole wait, then asked again. Before, the breaker cut the wait to 15 minutes and asked again every 15 minutes, to be refused each time. Keyless Exa answers a spent daily count with a 429 naming the hours to its reset (65,796 s on 2026-11-24). The call that meets such a limit answers that search is unavailable, not to try again in a minute. A quota answer that names its reset (`Limit` `{ kind: "quota", retryAfter }`) is off until then; one that names none is still off for the run. `offUntil(limit, now)` is the rule.

Keyless Firecrawl answers a spent daily limit in plain text ("daily limit without an account was reached"), as a tool result marked isError or as a JSON-RPC error, with no code. Its search and fetch now read that answer as a quota until the next 00:00 UTC by the web tools' clock (Firecrawl names no reset), so search turns Firecrawl off until then and asks the next provider, and fetch goes direct until then. Before, it was a plain failure: the breaker never opened and every call asked Firecrawl again. Firecrawl's words are still never passed on.
