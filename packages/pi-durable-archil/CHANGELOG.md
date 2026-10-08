# Changelog

## Unreleased

First release of `@parcha/pi-durable-archil`, versioned with the other packages in this repository (the release PR dates this
section and gives it the workspace version). It is the package developed as `pi-durable-archil` 0.2.0 before it was imported;
its notes follow, and its earlier history is not here.

Not in this release: `serve` (wake a released run on a request, `requestRun`), sleep parking (an instance that only waits
releases its host and is started again at the deadline), `fork` of a sealed run, a Docker host driver and a Docker
quickstart.

First release: a pi-durable host on an Archil disk. Each run is the subtree `runs/<id>/`, which holds pi's store and the
agent's workspace.

**The claim and the fence**
- One exclusive mount of `runs/<id>/` per run, verified by the delegation and an fsynced probe write. A second mount is
  refused (exit 76). The supervisor revokes a stale holder through the control API; the old holder's next fsync fails and its
  instance exits 75.
- Mount tokens are reusable, 24 h, one per start attempt, passed on the root-owned wrapper's stdin
  (`bin/archil-scoped`), never in argv or in an environment `sudo` sees; swept when no live mount needs them.
- Release: barrier, seal, unmount; a dead mount is cleaned, and where the kernel refuses every unmount (a Sysbox box) the
  mount is checked in, moved aside and its daemon killed (`archil-scoped retire`).
- Acquire deals with a dirty mountpoint. A non-empty mountpoint with no mount on it (files written by path after a mount
  vanished) is moved aside to `<mountRoot>/.stray/<run>-<tag>` before mounting, because archil refuses to mount over
  entries; the error is `MOUNTPOINT_NOT_EMPTY` when it cannot. An archil daemon left on the mountpoint with no mount (a client
  that dropped its mount after an authentication failure keeps its process and its control socket) is killed first
  (`archil-scoped stale`; it needs `/proc` to show root's processes). archil's "an older Archil process is still running" and
  "Failed to bind control socket" refusals are `MOUNT_FAILED` (exit 1), no longer `CLAIM_HELD` (exit 76); 76 now means a live or
  orphaned delegation.

**The store, the environment, the run**
- pi's `SqliteStorage` at `synchronous = FULL` in two profiles (exclusive, shared) behind a fence-aware facade: an I/O-class
  error marks the claim fenced and nothing is retried on it.
- The execution environment: pi's `NodeExecutionEnv` rooted at `work/`, commands under `no_new_privs`, the in-process
  `read`, `write` and `edit` confined to `work/` (resolved real paths, no-follow opens from a pinned directory), `read`
  declared replay-safe.
- `openDurableRun`: claim, owner lock, `run.json` (status, generation, holder, heartbeat, seal), the store, the seal check
  (`STORE_BEHIND_SEAL`, exit 65), pi's Harness, resume. The lease self-fence runs on a worker thread, so a main thread stuck in
  a FUSE request cannot keep a zombie's commands alive. The lease writes `run.json` and creates its directories through the
  claim directory opened at acquire, checked against the mount table, never by path: a mount that leaves the table under a
  live instance fences it (`CLAIM_UNMOUNTED`, exit 75) at the next heartbeat, and nothing lands under the bare mountpoint.
  An open that fails after the lease is up, including an environment factory that throws (`setpriv` missing), releases the
  claim and the owner lock and stops the heartbeat before it throws.
- `openRunLease`, the same lifecycle without a store or a Harness, and the `@parcha/pi-durable-archil/lease` entry for a host that
  owns its Harness (`"sideEffects": false`: a bundle of that entry is about 52 KB against 493 KB for the whole package).

**The supervisor and the hosts**
- `ensureRunning` (orphaned, lease fresh, lease expired with best-effort stop of the holder, revoke, start) and the CLI:
  `run --app MODULE`, `supervise` (`--every`, `--check`, `--create`, `--app`, `--sweep-tokens`), `status`, `release`. Exit
  codes 65, 70, 75 and 76 are terminal for the host's process supervisor.
- `run` drains on SIGTERM: release closes the Harness, then seals and unmounts, and the drain's outcome is the exit code.
  An app's work that rejects when the Harness closes under it ("Session is closed") does not end the instance before its
  release, so no delegation is left orphaned where the FUSE daemon dies with the instance (a container).
- The start grace: every start writes `runs/<id>/start.json` (the generation the new instance will write, and when) before
  the host driver runs. Until `run.json` reaches that generation or the grace passes (`startGraceMs`,
  `supervise --start-grace`; default the lease expiry, 0 off), a tick reports `starting` and neither revokes nor starts,
  so a short tick never fences the instance it just started.
- The start backoff: a start that ends before its first `run.json` write (76, `MOUNT_FAILED`) is counted in the
  next start's mark (`failures`, `lastExit`), and that start's grace is doubled per consecutive failure up to
  `startBackoffMaxMs` (`supervise --start-backoff-max`, default 10 min). One `start-backoff` line per step; the first
  `run.json` write resets the count.
- `localHost`: systemd transient units (`KillMode=control-group`, restart in place), or a detached child for development.
  Its `stop` kills the unit's FUSE scope while it is active, whatever the mount table says: a client whose filesystem
  failed at a token refresh drops its mount but keeps the mountpoint's control socket, which refuses the next mount.
- `daytonaHost`: a Daytona sandbox per instance with an in-box launcher; power-off, freeze and partition takeovers measured
  live.
- `deleteRunTree`: revoke, delete, and require an empty prefix.

**Package and docs**
- Compiled `dist/` with declarations (Node 22.19 or later), `exports` for `.` and `./lease`, a `bin`, peer ranges
  `@earendil-works/pi-durable` and `@earendil-works/chord` `~1.0.4`.
- README (the Durable Object mapping, the failure table, the security model), `examples/01-durable-chat`,
  `examples/02-paid-effect` (a charge cut in flight is never sent twice, across a kill and a freeze) and
  `examples/verify-production-path.sh`.
- Live suites against a scratch disk (`test/live/`), an acceptance suite on two hosts, and `npm run verify:tarball`.
