---
packages: @parcha/agentrun-serve
kind: fix
---
In Mode 2 (run folders on an Archil disk), a Modal, E2B or Agent37 sandbox is no longer shown as ready. It would start from its vendor's stock image, which has no Archil client, and failed at its start after a computer was made. Settings → Computers now says why, and `capabilities.computers` leaves the sandbox out while no provider can start one. An agent's save warns in the same words, and a run's start refuses it (409 `agent_not_runnable`) before any computer is made. A provider whose descriptor declares an `imageEnv` is offered as before.
