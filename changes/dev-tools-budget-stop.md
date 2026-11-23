---
packages: @parcha/agentrun-serve
kind: feature
---
The console's Dev tools tab says when a run stopped short for its budget, and how much of its cap its cost is. What stands out leads with it for a run whose `stopped_for` is `budget` or that had tool calls refused near its cap (`budget_refused_calls`): how many calls were refused, unrun, and the cap as it was set. The Cost tile says the run's cost against its `max_cost_usd` ("84% of its $0.75 cap"). A run with no cap, or one that never came near it, reads as before.
