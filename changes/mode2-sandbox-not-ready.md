---
packages: @parcha/agentrun-serve
kind: fix
---
In Mode 2 (run folders on an Archil disk), a Modal, E2B or Agent37 sandbox is no longer shown as ready. It needs Archil's image in your own vendor account, which this server can't put there yet, so it failed at its start. Settings → Computers says so, `capabilities.computers` leaves the sandbox out in Mode 2, an agent's save warns in the same words, and a run's start refuses it (409 `agent_not_runnable`) before any computer is made.
