---
packages: @parcha/agentrun-serve
kind: fix
---
Under a spend cap, a model request that left and then ended on an error counts at the worst case the cap held for it, as a request stopped before its end does. Before, it counted at its own usage, which is what had streamed when the error came (an overloaded event or a reset part way through: the input, and little or none of the output the provider can have billed), so a run could pass `max_cost_usd`. This holds in the run's process, where the next request is judged against the hold, and after a crash, where the store is read back: the request's start mark holds the figure, and a summary that failed writes its cost mark with `failed` and the hold. A request that never left (refused by the cap, its mark not written, a cancelled run's) still counts nothing. The run's shown cost is unchanged.
