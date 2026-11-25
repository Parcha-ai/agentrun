---
packages: @parcha/agentrun-serve, @parcha/agentrun-import, @parcha/agentrun-client
kind: fix
---
Wrapped: a failed read, a long read, a refusal, and a model's price, each said as they are.
- A read of the year that fails (the worker ended, or ran out of memory on a large home) is kept for a minute, like a read that worked. Each ask in that minute is `500 internal`, and the next ask after it reads again. The server logs the failure once, `agentrun-serve: the read of this machine's session history for <year> failed: …`. Before, the failure was dropped with no log, often after its ask had already answered 503, so each new ask started another full read and got another 503.
- Each of `GET /v2/wrapped`'s `models` has `unpriced_requests` (additive): how many of the model's requests its `cost_usd` leaves out. `wrappedHome`'s models carry `unpricedRequests` to match. The console marks "priced only" on the model that has unpriced requests, and shows "no known price" for a model none of whose requests were priced. Before, every model was marked "priced only" once any request of the year was unpriced, and an unlisted model showed "$0.00 priced only".
- The console's Wrapped page keeps reading through a `503` (a home still being read): it keeps its skeleton, asks again after the server's `retry_after_ms`, and stops when the page closes. Before, it showed "The server is busy" with a Retry button.
- A `403` on the Wrapped page shows the server's reasons as the why, and the next step is to open Wrapped on one owner's own server. Before, it said to sign in as the server's owner, which fixes none of these refusals.
