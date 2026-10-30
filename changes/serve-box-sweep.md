---
packages: @parcha/agentrun-serve
kind: feature
---
With a box host given (`startServe({ box })`: the box's reap and, on a shared server, its run cgroups), serve lets go the boxes runs leave.
- A run's box (its `box.json`) is reaped once the run process that recorded it is gone, by pid and start time, at start and when the run or its agent is archived. Only the reap's own count lets it go: empty, the record is marked reaped and its cgroup removed.
- A box a reap cannot empty, or whose reap fails, is quarantined in `box-quarantine.json` with its record kept. Every later start tries it again, by its own record, even after its run has opened another box. A run's boxes share its cgroup, so the cgroup is removed only when no box still held names it.
- A record with no pid and no cgroup (a crash before the box's first process was known) is cleared only once its writer is gone.
- Run cgroups that no record names are reaped through the cgroup and removed.
- No run starts or opens again before the start sweep is done.
- A start sweep that fails is tried again by the next start, open or relaunch rather than kept, so one transient error never holds every run back until a restart. A cgroup the reap already removed counts as removed.
- Each durable write of a box record goes through its own temporary file, so two settlements of one run's box at once (a run's archive and its agent's) never share or rename away each other's.
