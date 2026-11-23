---
packages: @parcha/agentrun-serve
kind: feature
---
The console's Dev tools tab says when a run stopped short for its budget, and how much of its cap its cost is. What stands out leads with it for a run whose `stopped_for` is `budget` (it wound down near its cap, named as it was set) or that had tool calls refused for its budget (`budget_refused_calls`): how many were refused, unrun. Refused calls name no amount, since a call refused before a raise met an earlier cap. The Cost tile says the run's cost against its `max_cost_usd` ("84% of its $0.75 cap"), "at most" that share where the cost is a ceiling. A run that stopped short with no request and no call in its trace (a CLI harness's) says so too. A run with no cap, or one that never came near it, reads as before.
