---
packages: @parcha/agentrun-computer
kind: fix
---
When `computerd probe --sockets` stops a root's walk at its entry budget, the reason it reports names the three top-level folders with the most entries walked (for example `/run: the walk stopped after 50000 entries, its budget (most under /run/x 41210, ...)`), so a failing `isolation.vendor-agent` says what filled the budget.
