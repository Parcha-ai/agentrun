---
packages: @parcha/pi-durable-disk
kind: feature
---
**`HostDriver.kill`: take an instance away as a crash would, and `kills` says what that takes**
- `kill(handle)` is optional on the interface and implemented by the three drivers. It drains nothing, releases
  nothing and cleans nothing: the run's claim is left as a crash leaves it, and the supervisor's next pass decides what
  follows. A handle the driver cannot reach, or one from another fleet or boot, is a no-op.
- `kills` is `process` or `box`. `localHost` kills `process`: `systemctl kill --signal=SIGKILL --kill-whom=all` on the
  unit, or SIGKILL to the child's process group (checked against its start ticks). `dockerHost` and `daytonaHost` kill
  `box`: `docker kill` (the container is left exited and the next start removes it), and the Daytona sandbox's delete
  (a refused delete stops it and deletes again). The launcher is not asked to stop.
- A kill that fails while the instance still runs throws `KILL_FAILED` (`LocalHostError`, `DockerHostError`,
  `DaytonaHostError`).
