---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
Completed workflows report model requests and tokens, including direct llm calls, and count tools from the model conversations in run metrics and /v2/stats. Decision receipts count as requests, with their reported tokens or as unmetered when they carry no usage.
