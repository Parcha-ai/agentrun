---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
A new run's directory now holds `revision.json`, the run's row and pinned revision as the agent store gives them, written before the run's process starts. The run's process reads its revision from that file, refuses it when its content does not give the revision's id (`revisionHash`, now exported by `@parcha/pi-durable-agent`, the check `readRevision` makes), and no longer opens the agent store. A run started before this change has no such file and still reads the store.
