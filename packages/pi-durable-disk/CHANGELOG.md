# Changelog

## Unreleased

## 0.1.0-beta.13 (2026-10-14)

**pi-durable 1.1**
- The peer ranges of `@earendil-works/pi-durable` and `@earendil-works/chord` widen from `~1.0.4` to `>=1.0.4 <1.2.0`:
  the package installs beside pi-durable 1.1 and still beside 1.0.4. It is developed against 1.1.0, and a CI job
  (`pi-durable-disk-pi-floor`) runs its whole suite again on pi-durable, chord and pi-ai 1.0.4, the lowest the range
  accepts. The conformance minimum follows the installed version (23 cases on 1.0.4, 24 on 1.1), and the scan-order
  control is skipped, with its reason, where the installed `Storage` contract has no order.
- pi-durable 1.1.0 requires a `Storage` to honour `order` on its conversation, entry, task and submission scans and to
  continue a cursor in the order it was returned with. The store's scans are pi's `SqliteStorage` behind the fenced
  database, so they do: pi-durable 1.1.0's storage conformance suite (24 cases, one of them the scans in either order)
  passes on both profiles, and a control shows the runner fails a storage that drops `order`.
- What the package reads of pi's internals is unchanged in 1.1.0: `durable_metadata.next_seq` for the seal, and the
  `retry` and `poll` checkpoints of generation and compaction for parking. Each is read off what the installed pi wrote:
  the seal test commits through pi's storage, a park test waits on a real retry, and a new test waits on a real
  deferred answer (pi's poll phase), so a version that moved either shape fails a test rather than this sentence.
- The Docker runtime image installs pi-durable, pi-ai and chord 1.1.0.

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
- **`beforeResume`: an awaited step before the run resumes**
  - `openDurableRun` and an app (`AppOptions`) take an optional `beforeResume(run)`, awaited once per incarnation after the
    Harness is open (its registry installed) and the run is live, and before the Harness resumes. No resumed task takes a
    step until it settles, and what it admits (a submission, a write) is committed before anything a resumed task's steps
    commit. It sees the open Harness, the open's context, the generation, the run record and the claim.
  - It also gets the store the Harness was opened over, read-only, and its head: `storage` has `scanConversations`,
    `scanTasks`, `scanDocuments` and `document` on a frozen object of its own, with no `commit` or `mintId` even through a
    cast, and `head` is the store's last committed sequence once the Harness is open. A recorder snapshots every document
    at `head` in the hook; until the hook commits, the current state is the state at `head`, which is how a document that
    keeps no history (`latest`, session and task documents) reads.
  - Use: a host reconciling what a resumed tool depends on (a browser, a mount) before the task that uses it continues;
    `onStep` cannot, since it is synchronous and gets no Harness.
  - A rejection fails the open like any open step (`before-resume`), and the claim is released.
  - New exports: the `BeforeResume` and `StoreReads` types.
- **`localRun(root)`: a run on a plain local directory, one machine**
  - New export `localRun(root)` returns `openDurableRun`'s `acquire` and `claimDir` for a run in a directory of this
    machine: the claim is the directory (made when missing), with no mount; `claimDir` is `openClaimDir(root, { fstype:
    null })`. Its barrier refuses once fenced and syncs nothing (SQLite makes the store's commits durable; `work/` is the
    OS's to flush). It is for one machine and says so: only the owner lock keeps a second process off the run.
  - `mountToken` is optional: required only with the default `acquire` (refused with `INVALID_ARGUMENT` before anything
    mounts when missing); a replaced `acquire` is handed an empty token.
  - A local run needs Linux, for now, and the README says why: the run's root is held open through `/proc/self/fd`
    (`openClaimDir`), and the default environment needs `setpriv` (`noNewPrivs`) and `/proc/self/fd` (`confineFiles`).
    macOS has neither.
- Installs beside pi-durable 1.2: the peer ranges of `@earendil-works/pi-durable` and `@earendil-works/chord` widen to `>=1.0.4 <1.3.0`, so the package installs beside 1.0.4, 1.1 and 1.2. It is still developed against 1.1.0; CI runs its whole suite at 1.2.0 (`pi-1-2`) and at 1.0.4 (`pi-durable-disk-pi-floor`).
  - pi-durable 1.2 reads a tool result's `output` and sends the model an empty result for one that says `content`, with no error (1.0.4 and 1.1 read `content`). The package's own source builds no tool result. The test apps' tools (the lifecycle app, the acceptance app, the live instance) and the paid-effect example give their text through `api.output()` and name neither key, which every version reads; tests assert the model gets a tool's text, not an empty result.
  - pi-durable 1.2 fails a Session on any error a `Storage` throws, except its own `StorageRequestError` (an invalid request) and a read its caller cancelled. The store is pi's `SqliteStorage` behind the fenced database and the lease's commit observer, neither of which rewraps an error, so an invalid read (a cursor that is not one, an unknown conversation) fails only that call. A fenced commit still fails the Session: on 1.2 later operations refuse with `SessionFailed`, its `cause` the fenced error, where 1.0.4 and 1.1 said the Session was poisoned.
  - pi-durable 1.2's `bash` answers a nonzero exit with an error result where 1.0.4 and 1.1 threw. The workspace barrier runs after it either way, with the command's writes on disk before the error result commits.
  - The floor job measured a mixed family: its install left pi-durable 1.0.4 at the root loading chord and pi-ai 1.1.0, and the version guard checked only what the package resolved. The guard now also checks chord and pi-ai as the installed pi-durable loads them, and reads `PI_EXPECT_VERSION` beside `PDA_EXPECT_PI_DURABLE`; the job installs one copy of each family package through `scripts/pi-leg.mjs`.
  - The test helpers that signal a process (`killQuietly`, `alive`) refuse a pid of 0 or below: a test that never learned its child's pid passed 0 from its `finally`, and `kill(0)` signalled the test runner's whole process group. A test removes a directory a run still writes into without racing its heartbeat (from #251).
- `@parcha/pi-durable-disk/lease` exports the four types its own signatures name: `AcquireOptions`, `PersistRecord` and `ClaimDir` (in `OpenRunLeaseOptions`) and `Unmounted` (in `Claim`). A host that imports only this entry can now write the type of every option it passes to `openRunLease`. They are type-only exports, so the entry's bundle still leaves out the supervisor, the host drivers, the CLI and the app contract. A test checks that every type of the package the entry's declarations name is exported by the entry.
- **A run on a local directory ends the commands a killed instance left running, before it resumes**
  - pi makes each command the leader of its own process group, so a SIGKILL of the instance does not reach its commands,
    and a local run has no unit cgroup to end them: a command kept running, and writing in `work/`, beside the next
    incarnation. Now a local run's environment marks each command it starts (`PI_DURABLE_DISK_COMMANDS=<its token>` in the
    command's environment) and records each of its commands' groups (the leader and every descendant it has seen, each by
    pid, start ticks and boot) under `<root>/commands/`: another environment's commands in the same process, or the app's
    own detached helpers, are never its to record. Each walk follows every recorded process still alive, so a background
    worker whose leader exited, and the children it starts later, are recorded too, and the next open, holding the owner lock, kills what is
    still the recorded process, waits until it is gone and clears the records, before the Harness opens (a new open step,
    `commands`, after `layout`).
  - A kill reaches a process only when its pid, start ticks and boot all match a record, and never pid 1 or below
    (`kill(-1)` would reach every process the user may signal), the opening process or its group. Only the instance writes records; a command that forged one could already kill what it names (it runs as
    the same user, or with `runAs` cannot write the instance's 0700 directory), so a record grants nothing.
  - What is still alive at the reap's deadline (a process in an uninterruptible wait, or one it may not signal) refuses the
    open: `HeldError` with holder `commands` (`COMMANDS_ALIVE`, exit 76), naming each pid and its command line and saying
    what to do (end them, then open the run again). The run never resumes beside it, its record stays, and the next open
    tries again. A record that cannot be written (a full disk) is said once on
    stderr and the recorder keeps trying. A command started within the last walk's interval (about 0.1 s) before the kill
    can be missed.
  - A claim opts in with `Claim.commands` (the directory); `localRun`'s claim sets it. A mount's run is unchanged: its host
    ends commands with the unit's cgroup or the container.
- **Stopping an instance never signals pid 1 or below, whatever its handle or state file says, nor does the lease watchdog**
  - `localHost`'s `stop` of a development-mode (`child`) handle signals the handle's pid as a group. A handle comes back
    from `run.json` with whatever was written there: pid 1 with pid 1's real start ticks made it `kill(-1)`, every process
    the supervisor's user may signal, and pid 0 (or a pid that is not an integer) with no start ticks made it `kill(-0)`,
    the supervisor's own group. It now signals only an integer pid above 1 whose handle carries start ticks.
  - The Daytona launcher's `stop` had the first of those: a state file naming pid 1 with its real start ticks made it
    SIGTERM pid 1 and `kill(-1, SIGKILL)`. Its liveness check now takes only an integer pid above 1 with start ticks.
  - The lease watchdog's sweep killed a direct child's process group unless it was the instance's own or 0 and below; a
    child in group 1 (possible in a container whose init's group is in the instance's session) made it `kill(-1)`. A
    child in group 1 is now killed alone.
- **A tool may write in the temp directory it was given**
  - `archilEnv`'s confinement made all of `<root>/tmp/` read-only to file operations, including the directories its own
    `createTempDir` (and `createTempFile`) hands out, so a tool that writes into the temp dir it asked for was refused
    `outside_work`: pi-vision's `read` of any media file failed on a disk run. A directory `createTempDir` returns is now
    writable, for the run's environments; the rest of `tmp/` (another run's directories, `tmp/` itself) stays read-only.
  - The tool may remove that directory (`env.remove`, as vision does when it is done), and its grant goes with it.
  - It is made through a held handle of `tmp/` that does not follow a link, and granted by name under the canonical `tmp/`:
    a `tmp/` a command replaced with a link is refused, and a directory swapped for a link grants nothing beyond itself.
- **The self-fence watchdog starts in a host launched with `--input-type=module`**
  - The watchdog's worker is eval'd CommonJS and inherited the host's Node flags. Under `--input-type=module` (a host that
    runs inline ESM through `-e` or stdin) Node read it as ESM, it threw `require is not defined`, and the run died at
    open. The worker now starts with no inherited flags (`execArgv: []`); it needs none of the host's.
- An example's test can no longer hang past its timeout: `runExample` waits for the example's output only until the timeout
  and a 2 s grace, then drops the pipes a process outside the example's group still holds and reports the run as timed out.
  The package's tests run with `--test-timeout=240000`, so a test that hangs fails with its name.
- **An example, `audit-across-crashes`: the store is the record**
  - A run on a local directory is killed twice in the middle of a tool call. A recorder in `beforeResume` snapshots every
    task, document and transcript entry at each incarnation's `head`, and the example prints a per-generation account (who
    asked what, who answered, which calls were cut and which generation settled them as `interrupted`) read from those
    snapshots alone. No disk, no key: `node examples/audit-across-crashes/main.ts` after the build, with pi-ai's faux model.
    A test runs it in `npm test`.
- **An examples index and the conventions every new example follows**
  - `examples/README.md` lists the examples with what each shows, what it needs, and whether CI runs it, and states how a
    new one is written: one directory and one property per example, self-contained imports, `node examples/<name>/main.ts`
    on a local directory with pi-ai's faux model (no key, no network), one closing `ok: ...` line, and a test under
    `test/examples/` that runs it on every change.
  - `test/examples/conventions.test.ts` checks what code can: each example's files, its imports (read from the parse tree),
    its test and its row in the index. `test/examples/_run-example.ts` runs an example from a scratch directory as its own
    process group and reaps the group whatever ends it, and `assertExampleOk` fails a run that exited 0 while a
    process it started still held its output; the quickstart's test uses both.
- **A quickstart on one machine: no disk, no key**
  - The README opens with a durable chat on a directory of this machine (`localRun`) and pi-ai's faux model: one process
    is killed (`SIGKILL`) after its third answer, a second opens the same run and answers the rest, and the transcript read
    back from the store has every message answered once. It is `examples/01-durable-chat/on-a-directory.mjs`.
  - The stranger test installs the packed package and its peers in an empty directory, runs the README's script and
    expects that line, so the quickstart a reader copies is the one that is checked.
- The README's bundle sizes for the two entries are re-measured: about 60 KB for `@parcha/pi-durable-disk/lease` against about 620 KB for the root entry (it said 52 KB and 493 KB), with the esbuild command that produces them.
- **The README starts with a path chooser and states how a run on a local directory fails**
  - "Choose your path" maps what a reader has (Linux and Node only, Docker and an Archil account, a Linux host with FUSE, an
    app of their own) to the quickstart or section to start with, and points to the examples index.
  - The failure table gains the rows for a run on a local directory (`localRun`): a crash or SIGKILL (the next open ends
    the commands the killed instance left running, then resumes), a power loss (the store holds, `work/` may be older), a
    second process on the machine (refused, exit 76), a process of the killed incarnation that will not die (the open is
    refused, exit 76, naming it), and another machine reaching the directory (unsupported: no fence).
    The layout names a local run's `commands/`.

## 0.1.0-beta.12, 2026-10-09

Renamed from `@parcha/pi-durable-archil`. The package is now `@parcha/pi-durable-disk` and its command is `pi-durable-disk`, for branding:
other disks may follow, and none is promised. It supports Archil only, because Archil gives a run's directory an exclusive claim and fences
the old holder's writes on takeover; a disk without both cannot carry the package's guarantees. The entries below name the package as it was
published.

- Moved with the name: the Docker image (`pi-durable-disk:local`), the tarball name (`parcha-pi-durable-disk-<version>.tgz`), the install
  paths `/usr/local/lib/pi-durable-disk/archil-scoped` and `/etc/sudoers.d/pi-durable-disk`, the token directory `/run/pi-durable-disk`, and the
  `X-Daytona-Source` header. An existing host's sudoers drop-in and wrapper copy need the new paths.
- Unchanged, because they name the Archil disk: `bin/archil-scoped` (and the `./bin/archil-scoped` export), `ARCHIL_API_KEY`, `archilEnv`,
  `ArchilCodingTools`, the claim's internals and the `archil` client it runs.


**A holder the control API lists without a path**
- Archil's control API resolves a delegation's path best-effort and can list one with no path, live or orphaned, even on a
  run id used once. `findDelegations` matched by path only, so such a holder read as none everywhere it is used
  (`ensureRunning`, `revoke`, `takeOver`, `deleteRunTree`, `fork`): the supervisor started a second instance into a live
  holder (refused, exit 76), kept starting into a dead holder's refused mount, and S3 kept refusing the run's deletes.
  `sweepTokens` judged such a run unheld too, so it could remove a live mount's token user once `run.json` said released.
- When nothing matches by path and some delegation has none, the pathless delegations are attributed by inode: one
  `Disk.exec` (`find runs -inum`, whose inode numbers are the control API's inode ids) maps their inodes to run
  directories, and those on the inode `runs/<id>` names now are the run's. A listing, a supervisor pass and a token sweep
  each share one resolver (`pathlessResolver`), so one costs at most one exec however many runs it decides. Nothing is
  recorded, so a deleted and recreated run directory matches as it is now. An inode on no run directory is no run's and
  is reported once on stderr.
- `ControlApi` gains an optional `exec(command)`; an SDK `Disk` has it and the CLI passes it. Without it, when the exec
  fails, or when the disk root or `runs/` cannot be read, a pathless delegation that could be the run's fails
  `CONTROL_API_FAILED` instead of reading as none: the supervisor's pass starts nothing, `takeOver` falls back to
  `mount --force`, and the token sweep keeps the run's users.

## 0.1.0-beta.11, 2026-10-08

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
  - `docker create` named `pda-<run>-<disk key>-g<attempt>` (the disk key is 8 hex digits of the disk and region) and
    labeled `pda.fleet`, `pda.run`, `pda.disk`, `pda.region`: a retry of the same attempt adopts a running container that
    carries all four labels, and the supervisor removes the token it minted for that start; a dead one is replaced, and a
    container by that name with other labels is refused. `--device /dev/fuse --cap-add SYS_ADMIN`, `--security-opt
    no-new-privileges`, no restart policy, and `--security-opt apparmor=unconfined` only where the daemon applies
    AppArmor (Docker's default profile denies mount(2); `apparmor: "auto"`, the default, decides from `docker info` and
    reports why once through `note`).
  - The mount token is copied into the created container as a root-only file (`docker cp -` of a tar built in memory),
    which the entrypoint makes the instance's stdin and removes before the instance starts. It is never in `docker
    inspect`, argv or an environment variable.
  - Status from `docker inspect` (exit 0 stopped, any other exit failed, paused running), `describe` with the exit code,
    stop as `docker stop` (drain) then `docker rm`. A dead container takes its mount with it: nothing is left on the host.
  - The app's directory (`--app-root`) is bind-mounted read-only with its `node_modules` hidden, so the app shares the
    image's single pi-durable.
  - Docker instances park and drain like local ones (`--park-threshold` 60 s by default, the drain from the stop timeout),
    and a `--restart` policy other than `no` in `dockerArgs` is refused, so a parked container stays exited until the
    supervisor starts the next.
- `archilEnv(claim, { runAs })` and `run --run-as USER`: for an instance that runs as root (in a container), every command
  runs as `runAs` with every capability set empty and no_new_privs, and `work/` plus every entry pi's in-process write,
  append and mkdir create under it are handed to that user (`lchown` through the confinement's pinned directory). The
  run's root, store and `run.json` stay root's; a command can neither change them nor read the archil daemon's environment.
- `HostDriver.start(ref, token, { attempt })`: the supervisor passes the generation the instance will open, so a driver can
  key its start on it. Drivers that ignore it are unchanged.
- The image installs one version of this package: the checkout's `package.json` version, from a tarball `npm pack` wrote
  into `docker/package` (which must be that version) or else from npm; `--build-arg PDA_VERSION` names another version or
  a dist-tag, never by default. A package without the Docker path (a release from before it) is refused.
- `examples/docker-quickstart.sh`, and `--host docker` for both examples' demos. It reuses an image only when the image was
  built from this checkout's package version, and rebuilds it otherwise.
- Measured with Docker Engine 29 on Ubuntu 24.04: a killed container is replaced in about 1 s and the run resumes about
  2 s after the kill; a frozen one is replaced 7 to 8 s after the freeze (6 s test lease) and exits 75 within 0.5 s of its
  thaw; a commit from a container costs what it costs from the host. macOS is not verified.

**Fixes**
- Known issue in 0.1.0-beta.10, fixed here: an idle `run` instance (no `--serve`, nothing running) exited without draining or
  releasing once its work finished; the supervisor then revoked and restarted it. It now stays up until it parks, drains or fails.

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
