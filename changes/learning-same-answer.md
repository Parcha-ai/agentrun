---
packages: @parcha/agentrun-serve
kind: fix
---
A run its learned workflow answered keeps the path `workflow` when the agent restates the workflow's JSON inside prose (a fenced `json` block with words around it), the same as when it restates it bare.
