---
packages: @parcha/pi-durable-disk
kind: fix
---
On a run on a local directory, the next open after a killed instance ends the whole process group of each command the instance was running again, children included. Since commands started under setpriv's `--pdeathsig KILL`, the command itself (its group's leader) died with the instance. The open's reap kills a group only while it can verify the leader is still the recorded process, so it fell back to the descendants its walks had recorded, and a child forked in the last walk's interval before the kill (100 ms) kept running. A command the run records now starts without the death signal, so its leader outlives the instance and the reap ends the group. Programs started beside pi under `confinePrefix()` (another harness's CLI) keep it.
- New limit, stated plainly: on a local directory, a command a killed instance was running, a single-process one included, keeps running until the run's next open reaps it. Before, a single-process command died with the instance.
