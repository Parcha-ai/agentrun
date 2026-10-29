---
packages: @parcha/pi-durable-disk
kind: fix
---
A command a run starts dies with the run's process: the confinement prefix (`setpriv`) now passes `--pdeathsig KILL`, so a run process killed mid-command leaves that command running no longer. It reaches the command setpriv starts, not that command's own children. `ArchilExecutionEnv.confinePrefix()` returns the prefix, so a program a host starts beside pi (another harness's CLI) runs under the same one. Under `runAs` the signal holds only if setpriv sets it after switching the uid; that mode's container test must show it.
