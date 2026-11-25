---
packages: @parcha/agentrun-serve
kind: fix
---
Completed workflows write request, token and tool counts from their model conversations to run metrics and /v2/stats. Decision receipts count as requests, with their reported tokens or as unmetered when they carry no usage.
