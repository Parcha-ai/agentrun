---
packages: @parcha/agentrun-computer
kind: fix
---
The conformance sweeps delete only their own computers. `daytona-sweep.js`, `e2b-sweep.js` and `modal-sweep.js` `--after` used to delete every sandbox with `agentrun.computer=1` that was not there before the run, so one another user of the account made during a live run (a server's computers) went too. Now each deletes only those that also carry a conformance run's label (`agentrun.conformance`). The others are left alone, never named by a call, and counted in a new `leftAlone` field of the sweep's JSON line. `DaytonaProvider.listLabelled` and `E2BProvider.listLabelled` now return each sandbox's labels; Modal's sweep reads each new sandbox's tags.
- Daytona's connect no longer leaves an abort listener on its signal per connect.
- The `isolation.vendor-agent` case records every probed target's outcome in one line of the report, on a pass as well as a fail.
