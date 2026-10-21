---
packages: @parcha/pi-durable-disk
kind: fix
---
**SECURITY: `localHost` stops and kills only a unit it could have started, and says so when it refuses one.** A handle comes back from `run.json`, which the run's user can write, and `stop` and `kill` act on it as root (`systemctl stop` and `kill`, `archil unmount`, `fusermount`, `umount`, `rmdir`). Before, only the shape of the unit's name was checked, so a handle that named another service on the host had it stopped. Now `stop` and `kill` act only on a unit with the driver's `unitPrefix` whose mountpoint is one run's under the driver's mount root, as `dockerHost` and `daytonaHost` act only on their fleet's. For any other handle of this host and boot, and for a child-mode handle whose pid is 1 or below or that has no start ticks, they throw `INVALID_ARGUMENT`, naming the handle and saying that nothing was stopped or killed. `supervise` logs that STONITH as `failed` with the reason, where it used to log `stopped`, then revokes and starts as before. A handle of another host or boot, and a child that is already gone, are still no-ops; `status` is unchanged.

- Who notices: a supervisor that changed `--unit-prefix` or `--mount-root` between runs no longer stops the units started under the old values. Their STONITH logs the refusal, and the revoke fences them as before.
