---
packages: @parcha/agentrun-serve
kind: feature
---
An agent that learns now tidies what it learned. After a run's learning merges, the server queues one consolidation run for the agent when 5 or more merges have landed since the last one was queued and its active notes are past the 8 KB budget, or when a skill and its workflow draft have drifted apart (one changed without the other). That run is not listed with the agent's runs. It asks once for replacements: one note for each group of notes that say the same rule, each keeping every rule of the notes it replaces, and a skill and its draft written back to describe the same steps. Then it goes through the same checks, grade and merge as a run's learning, so a replacement that loses or changes a rule is dropped and the old notes stay. It is graded on the server's grade model, its cost is counted in `learning.spend`, and an agent has at most one consolidation queued or running at a time. Upgrading: nothing to do.
