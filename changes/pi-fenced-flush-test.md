---
packages: @parcha/agentrun-pi
kind: ci
---
**A step's next attempt on a fenced durable-disk lease is refused at the recovery driver's flush**
- A workflow run on a durable disk, wired as a host wires it (pi's workflow extension over `openDurableRun`), whose lease is fenced while a step's first attempt is out. The recovery driver may admit the next attempt in that process, since a fence is not final; the flush before it commits through the run's Harness over the lease's observed storage, so it is refused with the fence and the node runner is not called again. Two ways in: a failed heartbeat write, and a lease that lapsed while the process was stuck (the watchdog thread's lapse, found at that commit).
