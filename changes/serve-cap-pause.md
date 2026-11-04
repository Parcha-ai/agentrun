---
packages: @parcha/agentrun-serve
kind: feature
---
A run that its spend cap stops for room now pauses instead of failing. When what is left of `max_cost_usd` cannot buy the next request's least, the request is still not sent, so the cap holds, and the run ends up as follows:
- It is `input_required` and `waiting`, with `error` null and `pending: {kind: "budget", cap_usd, spent_usd, needs_usd, said, at}`. `spent_usd` is what the cap counted as taken, and `needs_usd` is the least the refused request needs. They are kept on the refusal's start mark, so a restarted server reads them too.
- Its timeline shows a waiting row: "Paused at the run's $1 cap: Not sent: …".
- The webhook's `run.needs_input` carries `pending.kind: "budget"`.
- Its process is let go while it waits, so it holds no place. A restarted server reads it paused.
- A message to a paused run is `409 budget_reached` (a new error code). A cancel ends it.

A refusal no cap fixes still ends the run `failed` with `spend_cap_reached`: an unknown spend, a model with no price or no output ceiling, or an input that could not be measured. So does a cost found past the cap after a response. Raising the cap of a paused run comes next.
