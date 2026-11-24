---
packages: @parcha/agentrun-serve, @parcha/agentrun-web
kind: feature
---
serve's `web_search` ranks its results with Jev wherever the server holds a TypeSafe key (`TYPESAFE_API_KEY`, set or saved). Jev (`jev-1.14.0`) scores each result against the query and the results are reordered by that score (rerank+label): every result is kept, each with its `relevance` (0 to 1), and a `sift` line says how they were ranked, or why not. Each Jev request is held on the run's spend cap at Jev's published price and settled at the cost Jev reported, never above the hold. Set `AGENTRUN_WEB_JEV_OFF=1` to turn it off; a server with only an OpenRouter key runs no web ranking. GET /capabilities' `why` for `web_search` says which.
- A Jev failure leaves the results as the provider gave them, with a `sift` line saying it did not run.
- `web_fetch` is never judged: a fetch asks Jev nothing and its page is whole. Its answer carries a `sift` note saying it was not run.
- serve's `web_destinations` start line gains `classifier`: `"jev jev-1.14.0 rerank+label"`, or `off`. It never holds a key.
- The runner hands TypeSafe's key to a run only when one of its web tools runs and Jev is not turned off, as it hands Parallel's.
- web: `jevWebDecider` builds this decider from what it is handed (the key, `jevProvider`, a price, a fetch), never from the environment, and `null` gives none. `Pay` gains an optional `charged`, the cost a request reported once it was answered, which `decisionPay` passes for each decision request.
