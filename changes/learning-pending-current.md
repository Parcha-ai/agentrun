---
packages: @parcha/agentrun-serve
kind: fix
---
A run that merged a note, skill or workflow draft held for its owner's OK stops saying it waits once the owner approves or retires it. The run's view, its row in a runs list, its whole learning (`GET /v2/runs/{id}/learning`) and its timeline's learning row read each held item's status on the agent's folder's main now: still pending, it waits; approved, it reads as learned; retired, it is said no more. The run's record keeps what its merge wrote. Main's statuses are read once per agent per commit of main. Upgrading: nothing to do.
