---
packages: @parcha/agentrun-serve
kind: fix
---
Nine of the code-review template's eval cases capped each run at $0.10, below what a review costs: the eight reviewers' first requests are held at their worst case together, so a run paused at the cap at about $0.07 spent, before it answered, and the case failed for spend, not for its review. On the default model the dearest run of those cases costs $0.15; each case now caps a run at $0.30, twice that. These are the eval's own budgets (each case's `max_cost_usd`); the template's budget for a user who applies it is unchanged.
