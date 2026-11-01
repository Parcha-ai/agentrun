---
packages: @parcha/agentrun-serve
kind: feature
---
A new run's directory now holds `revision.json`, its row and pinned revision as the agent store gives them, written before the run's process starts. The run's process reads its revision from that file and no longer opens the agent store, so it can start where the store is out of reach. A run started before this change has no such file and still reads the store.
