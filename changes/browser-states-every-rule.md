---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
Capabilities now mark a tool that runs only on the server `runner_only: true` (the browser), as they mark a box-only one `sandbox_only`. The console's Tools step reads it. A tool card now states every rule that keeps its tool off here, together: the harnesses that run it, where it runs, and what it lacks. For the browser on Claude, in a box place, it says "Runs on Pi here, not on Claude; Server-only: it runs on the server, and this agent's place is the docker box". Before, a card stated one rule at a time. On Claude it named only the harness. On pi, in a box place, it said nothing, and the save was then refused.
