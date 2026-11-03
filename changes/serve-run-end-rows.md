---
packages: @parcha/agentrun-serve
kind: fix
---
A run's timeline no longer loses rows when its end is carried back. The live "Run started" and "Run finished" rows, which no agent-store entry records on any harness, are never served, so the rows a reader pages through once a run reads `completed` are the rows it ends with. A cancel sent while a run that answered is finishing is refused (`cancel_requested: false`, `already_terminal: true`), and the run ends `completed` instead of `cancelled`.
