# Changelog

## Unreleased

**Serve, sleep parking and fork**
- `run --serve PORT` puts an HTTP front on the open run: `POST /submit` (pi's submit with the caller's `requestId`, which pi
  deduplicates per conversation in the run's store, so a retry that reaches the next incarnation, even on another host, gets
  the same submission and, with `wait: true`, its answer), `POST /abort`, `GET /events` (pi's agent events as server-sent
  events) and `GET /status`. The instance listens before it opens and writes its address into `run.json`'s holder
  (`holder.serve`); it answers 503 `OPENING`, `PARKING` or `RELEASED` while it opens, parks or is gone.
- A bearer token: optional on 127.0.0.1, required on any other `--serve-host` (`SERVE_TOKEN_REQUIRED` before anything binds).
  It is read from a file of mode 0600 (`--serve-token-file`, never argv or the environment) and compared in constant time
  on every route. A wildcard bind (0.0.0.0, ::) also needs `--serve-url`, the address clients reach, which is what
  `run.json` carries (`SERVE_URL_REQUIRED`).
- `requestRun(ref, request, { host, ensure, token })`, the client: it finds the instance through `run.json`, sends while the
  holder's lease is fresh (a request is dropped when the lease lapses under it), and otherwise calls `ensureRunning` with
  demand. After a start, its own or one the supervisor reports `starting`, it waits for that generation instead of asking
  again, so one cold request makes one start.
- Sleep parking (`run --park-threshold`; the local driver passes 60 s, `supervise --park-threshold 0` turns it off): after
  every commit the instance classifies pi's tasks; when everything that could run only sleeps in a retry or deferred-poll wait
  longer than the threshold, it writes `run.json` `sleeping` with `wakeAt` (the deadline), releases and exits 0, and the
  supervisor starts it at `wakeAt`. With `--serve`, a run with no live work parks after `--park-idle` with `wakeAt` null (a
  request wakes it). Open requests and event streams keep the instance up; a blocked task does not. The deadline is read from
  pi's retry and poll checkpoint in one function; any other shape counts as busy.
- The app module's `wake` hook replaces how the wake is recorded: a refusal keeps the instance up through the wait, while a
  failed `run.json` write is a fence (exit 75; the lease path resumes the run and pi sleeps out the remainder). `root` gives
  the options for the root conversation serve creates.
- A drain on SIGTERM: no new submissions, then up to `--drain-timeout` (the local driver: its stop timeout minus the smaller
  of 5 s and half of it) for running work; the wake it writes is now, the wait's deadline, or null when idle. Work cut at the
  deadline resumes on the next open (safe tools rerun, unsafe ones report the interruption). The app's work rejecting when a
  park's release closes the Harness under it does not end the instance before its release, as for a drain.
- `leaseParkTarget(lease, harness)`: parking for a Harness a host opened over `openRunLease` (the wake through the lease's
  `setStatus`; the release closes the host's Harness, then the lease).
- `fork --id A --new-id B` (`fork(ref, newId, { control, mountRoot })`): copies a released, sealed run (paused, sleeping, done
  or failed, with no delegation) under two short exclusive mounts of its own into a new run that starts `paused` at
  generation 0 with the source's `sealedSeq`, so its first open is generation 1 and a lossy copy is refused
  (`STORE_BEHIND_SEAL`). The source is only read. `run.json`, `owner.lock`, the start mark and `tmp/` are not copied. A fork
  owns the new run's directory only while it holds that directory's mount: one that fails after that empties it through
  its own mount and removes it; one that lost the directory to another fork or start leaves it alone.

**The Docker host driver**
- `dockerHost` (`supervise --host docker --image IMAGE`): one container per instance, from the image `docker/Dockerfile`
  builds (Node 24, the archil client 0.8.42 checked by sha256 per architecture, FUSE, tini, the run user `pda`, this
  package). Nothing on the machine that runs the supervisor needs root, FUSE or the archil client.
  - `docker create` named `pda-<run>-g<attempt>`: a retry of the same attempt adopts a running container and replaces a
    dead one. `--device /dev/fuse --cap-add SYS_ADMIN`, `--security-opt no-new-privileges`, no restart policy, and
    `--security-opt apparmor=unconfined` only where the daemon applies AppArmor (Docker's default profile denies mount(2);
    `apparmor: "auto"`, the default, decides from `docker info` and reports why once through `note`).
  - The mount token is copied into the created container as a root-only file (`docker cp -` of a tar built in memory),
    which the entrypoint makes the instance's stdin and removes before the instance starts. It is never in `docker
    inspect`, argv or an environment variable.
  - Status from `docker inspect` (exit 0 stopped, any other exit failed, paused running), `describe` with the exit code,
    stop as `docker stop` (drain) then `docker rm`. A dead container takes its mount with it: nothing is left on the host.
  - The app's directory (`--app-root`) is bind-mounted read-only with its `node_modules` hidden, so the app shares the
    image's single pi-durable.
- `archilEnv(claim, { runAs })` and `run --run-as USER`: for an instance that runs as root (in a container), every command
  runs as `runAs` with every capability set empty and no_new_privs, and `work/` plus every entry pi's in-process write,
  append and mkdir create under it are handed to that user (`lchown` through the confinement's pinned directory). The
  run's root, store and `run.json` stay root's; a command can neither change them nor read the archil daemon's environment.
- `HostDriver.start(ref, token, { attempt })`: the supervisor passes the generation the instance will open, so a driver can
  key its start on it. Drivers that ignore it are unchanged.
- `examples/docker-quickstart.sh`, and `--host docker` for both examples' demos.
- Measured with Docker Engine 29 on Ubuntu 24.04: a killed container is replaced in about 1 s and the run resumes about
  2 s after the kill; a frozen one is replaced 7 to 8 s after the freeze (6 s test lease) and exits 75 within 0.5 s of its
  thaw; a commit from a container costs what it costs from the host. macOS is not verified.

## 0.1.0-beta.10, 2026-10-08

First release of `@parcha/pi-durable-archil`, versioned with the other packages in this repository. It is the package developed
as `pi-durable-archil` 0.2.0 before it was imported; its notes follow, and its earlier history is not here.

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
