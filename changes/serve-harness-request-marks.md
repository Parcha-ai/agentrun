---
packages: @parcha/agentrun-serve
kind: fix
---
A run on codex or claude-agent marks each model request on its root as the request leaves, as a pi run's are. A run that ends with a request still out and never opens again then carries back a cost that reads unknown, never the sum of the others without it. That is a run cancelled, or failed, mid-request.
