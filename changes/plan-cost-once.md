---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A run on your Claude or ChatGPT plan counts each plan request once in its cost's `plan` even when its booking was written twice, its spend cap no longer reads a plan request in flight as not priced, and a workflow decision on such a run is charged what its provider charged instead of being counted as the plan's at $0. A decision on a run on a free model whose charge was lost now reads as unknown, never as a known $0.

This applies to new runs only. Decisions already booked as the plan's at $0 stay $0, and so does a decision marked the plan's before the deploy that a resumed run cuts after it: nothing is backfilled.

Some decisions with no cap on a plan run now read as unknown (`cost.usd` null) where they read $0 before. Unknown is the correct reading: their provider charged them and the charge was not said.
