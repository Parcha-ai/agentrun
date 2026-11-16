---
packages: @parcha/agentrun-serve
kind: fix
---
A run's `learned_workflow` tool runs only what serves: a learned workflow's champion (the revision promoted last), never a revision that is replaying, queued, held or not yet decided. Before, a run its workflow did not serve first (the revision replaying with nothing promoted yet, the champion held, or the champion not taking the run's input) handed the agent the folder's newest revision to call, so an unpromoted draft could answer the run. A workflow with nothing promoted is left out of the tool; one no promotion record names (no run's input fit it yet) is offered as before.
