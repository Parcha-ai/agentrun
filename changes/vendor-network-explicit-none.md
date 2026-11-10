---
packages: @parcha/agentrun-serve
kind: fix
---
An explicit `AGENTRUN_BOX_ALLOW=none` is honoured for a computer that runs only on the vendor's own network (a cloud phone, Browserbase, Kernel): its run is refused at the start and at the claim, in words that name the setting, instead of running open. Under a list, the default or the operator's own, it still runs open, and Settings → Computers says so. A run whose launch names no box allow-list (one started before every launch carried it) now reaches what the server allows now, never an open network; a sandbox with none still has no network.
