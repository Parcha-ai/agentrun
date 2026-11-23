---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A run on your Claude or ChatGPT plan counts each plan request once in its cost's `plan` even when its booking was written twice, its spend cap no longer reads a plan request in flight as not priced, and a workflow decision on such a run is charged what its provider charged instead of being counted as the plan's at $0.
