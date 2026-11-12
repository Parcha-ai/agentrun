---
packages: @parcha/agentrun-serve
kind: fix
---
Removed the file-era budget pause (budget.ts: the budget.json and cap.json marks) and the host-tool api's `conversation` member, which nothing calls; the runner parks and raises through the store's budget entries.
