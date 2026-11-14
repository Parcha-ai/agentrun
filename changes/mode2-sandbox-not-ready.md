---
packages: @parcha/agentrun-serve
kind: fix
---
In Mode 2 (run folders on an Archil disk), a Modal, E2B or Agent37 sandbox is no longer shown as ready. It would start from its vendor's stock image, which has no Archil client, and failed at its start after a computer was made. Settings → Computers now says why, `capabilities.computers` leaves the sandbox out while no provider can start one, and a run's claim refuses it in the same words before any computer is made. A provider whose descriptor declares an `imageEnv` that the owner sets is offered as before.
