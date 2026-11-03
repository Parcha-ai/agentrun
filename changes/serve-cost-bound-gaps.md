---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
Two more unknown costs now say the most they can be. On claude-agent and codex, an answer whose cost was still on its way when its turn ended (written pending) reads `usd: null` with `at_most_usd`: the known costs plus what was held for that request. That holds live, and after the run ends before the cost comes. Before, it read unknown with no bound. A request a crash cut before its start mark reached the run is now marked by the next open from its runner record, with what was held for it. Its cut answer then counts at its own worst case. Before, it counted at another request's, which could be far smaller.
- `REQUEST_COST_PENDING` may carry `heldUsd`, and a `REQUEST_COST_LATE` of unknown cost may too. The timeline counts each at that figure, or else at one of its kind's start figures.
- A cost that is unknown because a model's answer came back with no price, with nothing to bound it, now says so on the timeline's usage row: "Cost so far: unknown: <model> has no price here, over N model requests".
- A request that ended on an error after its response began, marked so on its end (`error`, with what was held for it), counts in the bound at that figure in place of its error entry's partial cost, and no longer takes another open request's figure out of the bound.
- A late cost closes the pending cost of the request it names (its key and number), so late costs that come in another order keep each pending request's hold; one that names none closes the oldest, as before.
- A cut request whose recovering open went too, after it booked the request cut and before its entries landed, is still marked from its record by the open that writes its entry.
