---
packages: @parcha/pi-durable-agent
kind: feature
---
The timeline labels a `web_search` call: `Searched the web for "<query>"` (the query's URLs cut to their origin, path and query keys, and the whole cut to 60 characters), `Searched the web` with no query, and `Searched the web 3 times: "…"` for a run of them, where it read `Using tool: web_search`.
