---
packages: @parcha/pi-durable-disk
kind: fix
---
**Stopping a local or Daytona instance never signals pid 1 or below, whatever its handle or state file says**
- `localHost`'s `stop` of a development-mode (`child`) handle signals the handle's pid as a group. A handle comes back
  from `run.json` with whatever was written there: pid 1 with pid 1's real start ticks made it `kill(-1)`, every process
  the supervisor's user may signal, and pid 0 (or a pid that is not an integer) with no start ticks made it `kill(-0)`,
  the supervisor's own group. It now signals only an integer pid above 1 whose handle carries start ticks.
- The Daytona launcher's `stop` had the first of those: a state file naming pid 1 with its real start ticks made it
  SIGTERM pid 1 and `kill(-1, SIGKILL)`. Its liveness check now takes only an integer pid above 1 with start ticks.
