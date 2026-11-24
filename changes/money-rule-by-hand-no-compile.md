---
packages: @parcha/agentrun-serve
kind: fix
---
The money rule's by-hand cost no longer counts a compile turn as the agent's. An agent run whose end compiled a workflow was read on the by-hand side at its job plus that compile turn, so one compile could raise the agent's by-hand mean far above what its runs cost, and a workflow that cost more a run than the agent kept serving. The rule now reads each run off the served paths the way `GET /runs/{id}` reads it: its compile turns are charged to the revision they drafted, and its other learning (a follow-up's rounds, its audit shadow) stays on the run. The served side is unchanged. `GET /agents/{id}/learning/cost` `workflows[].by_hand` and the decision a run's launch reads both change.
