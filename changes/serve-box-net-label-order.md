---
packages: @parcha/agentrun-serve
kind: fix
---
A Docker box's network label (`agentrun.net`) is the same for the same hosts in whatever order and case `AGENTRUN_BOX_ALLOW` names them, so reordering the setting no longer makes a run's box again. A box labelled before this with a list that was not in sorted order is made again once, at its run's next open. The serve README no longer says Docker Desktop on WSL2 always passes the runtime check: it keeps its data outside the distro, so its box has no network unless the distro has that directory.
