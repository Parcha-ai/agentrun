---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/pi-durable-agent, @parcha/agentrun
kind: feature
---
A run's spend cap prices each model request's input from the previous request's cache (`cap_mode` `expected`, the default): the input the previous request of its conversation read from or wrote to the cache counts at the cache-read price when it ended less than 4 minutes before, so a cap pays for about what the run really spends instead of pausing near half of it. Output never passes the cap; a cache miss can, by at most the request's bound, served as `cost.overshoot_bound_usd` while it is in flight (and as `pending.overshoot_bound_usd` on a run paused at its cap). The real cost is booked, one timeline row says `Went $X over its cap on a cache miss (at most $Y).`, and the run pauses at its cap instead of failing. `cap_mode: "strict"`, on a run's body or an agent's definition, keeps the worst case: every input token uncached.
