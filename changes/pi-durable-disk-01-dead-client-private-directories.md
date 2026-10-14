---
packages: @parcha/pi-durable-disk
kind: fix
---
**A dead client's private directories**
- Each client holds delegations on its own private directories too, `.archil/client-<clientId>` and its `unlinked/`, which the
  control API lists with no path. A client that dies (its FUSE daemon killed under a running instance, a lost host) leaves them
  orphaned after the run's own delegation is revoked and its directory deleted. They block no run (they are on the client's
  own directories, never a run's), but nothing revoked them, so they piled up and resurfaced in listings: a scratch disk held
  96, from 86 clients, all from the live suites' daemon kills. Revoking them is hygiene.
- `revoke` (and so `takeOver`), the supervisor's takeover in `ensureRunning` (an orphaned holder or an expired lease), and
  `deleteRunTree` now also revoke those private-directory delegations, from the same listing, and only for the clients they
  are already revoking on the run: never as a sweep. One `Disk.exec` (`stat`) confirms each inode is the client's own private
  directory, and a client that holds anything else (it may hold another run) keeps everything but the run's delegation.
  Best effort: without `exec`, or when it or a revoke fails, they stay, and the run's revoke never fails for them. The run's
  own delegations, which every count and decision uses, are unchanged, and `revoke` still returns only those.
- `revokeBestEffort` revokes what `revoke` revokes and skips every revoke that fails (`revoke` stops at the first); only the
  listing can fail it. `deleteRunTree` uses it, and the live suites' cleanups revoke through it (by path or by inode, and the
  holders' private directories) before they delete a run's tree; the Docker, Daytona and lifecycle suites matched by path
  only. The run suite's daemon-kill and host-loss tests check that no delegation of a killed client is left.
- New exports: `revokeBestEffort`, `revokeCompanions`, `companionsOf`.
