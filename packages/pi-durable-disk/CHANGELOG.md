# Changelog

## Unreleased

## 0.1.0-beta.16 (2026-10-18)

- **A place's outcome carries the models the run's live parts chose (`PlaceOutcome.models`)**
  - `PlaceOutcome.models?: Record<string, string>`: the role-to-model ids (`lead`, `eyes`, ...) the app reported, on any
    outcome status, so a supervisor's manifest names the models of a remote run as of a local one.
  - `archilPlace` reads it from `run.json`'s final status detail (`detail.models`); `localPlace` from the instance's
    `{"outcome":...}` line, or from `run.json` without one.
  - Both keep it only when it is a plain object whose values are all strings. A missing or malformed one is left out, never
    replaced by `{}`. Before, `localPlace` passed the outcome line's `models` through unchecked, a malformed one included,
    and `archilPlace` never carried it.
- **`archilPlace.recordHome`: a runner on a box records into the run's disk, and the place brings the recording home**
  - `Place.recordHome` (`PlaceRecordHome`): `dir(attempt)` is where that attempt's runner records, and
    `bringHome(into, { final })` brings what it recorded into the supervisor's recording directory. `archilPlace` has
    it when its control can list (`RecordControl`, as `archilControl` does); `localPlace` has none, since its runner
    writes the supervisor's directory itself.
  - `dir(attempt)` is `<root>/record/<attempt>`, inside the run's directory. `bringHome` reads it over S3 (list and get,
    never the run's claim). Blobs come first, hash-checked and written whole; then the new whole lines of each
    `.spool/*.jsonl` segment, with an offset per file name kept as what `into` already holds, so it is idempotent across
    calls and processes. Carriers that overlap on one destination append each line once: one call at a time per
    destination in a place, and a lock file per spool file across places and processes (a gone holder's is taken over;
    one held past 5 s is `CARRY_FAILED`). Every write is carried to its last byte.
  - With `ensure.create`, each start first makes the EMPTY `signals/`, `record/<attempt>/.spool/` and
    `record/<attempt>/blobs/` over the control, owned by the run user (mode 0755), while no delegation holds the run. A
    directory made by path on an Archil mount was seen to refuse file creates. Every file in them stays the runner's; a
    refused put fails the start with `DIRS_REFUSED`.
  - Box receipts: `HostDriver.box(handle)` (`HostBox`) and `PlaceStatus.boxes`. `archilPlace.status()` lists a receipt
    for each box it started, released ones included: provider, kind, `from`, `to` and, when it has a price, the published
    list price per second (`usdPerSecond`), the page it was read from (`source`) and the date read (`priced`). An unpriced
    box has none of the three, never 0, and no field holds the provider's box id. `daytonaHost` reports its sandboxes, priced at `DAYTONA_LIST_PRICES`
    (https://www.daytona.io/pricing, read 2026-10-16), with the "first 5 GiB free" applied to disk (the footnote's
    placement is ambiguous). A box of unknown size has no price, nor does a box with a GPU, which the page prices per
    model (`daytonaUsdPerSecond`). `localPlace` reports none.
  - Failures carry codes (`PlaceError`). `BLOB_MISMATCH` is thrown after everything else came home. `CARRY_FAILED` is
    thrown for a list or get that fails, and on `final` for a line whose blob never landed. `BOX_GONE` is never thrown
    by this place: the recording lives on the disk, which outlives the box.
- **A seed of any length stays in the supervisor's start grace**
  - While a new run seeds it has no `run.json` heartbeat, and `ensureRunning` keeps a start in its grace only while the
    start mark (`runs/<id>/start.json`) is younger than the grace (90 s by default). A longer seed was taken as a failed
    start: revoked, then seeded again.
  - Now, while the seed runs, the instance rewrites the mark's `at` every heartbeat through its claim (fsync and rename).
    It does so only when a supervisor's mark for generation 1 is there, keeping its generation, `by`, `failures` and
    `lastExit`. The rewrite runs on a thread of its own, one at a time, so a seed that blocks its thread (a synchronous
    import) stays covered. It stops when the seed ends, before the open goes on, and `run.json`'s heartbeat takes over.
  - A seeder that dies stops rewriting, and the grace runs out as for any start. The mark's format does not change.

## 0.1.0-beta.15 (2026-10-16)

- **`HostDriver.kill`: take an instance away as a crash would, and `kills` says what that takes**
  - `kill(handle)` is optional on the interface and implemented by the three drivers. It drains nothing, releases
    nothing and cleans nothing: the run's claim is left as a crash leaves it, and the supervisor's next pass decides what
    follows. A handle the driver cannot reach, or one from another fleet or boot, is a no-op.
  - `kills` is `process` or `box`. `localHost` kills `process`: `systemctl kill --signal=SIGKILL --kill-whom=all` on the
    unit, or SIGKILL to the child's process group (checked against its start ticks). `dockerHost` and `daytonaHost` kill
    `box`: `docker kill` (the container is left exited and the next start removes it), and the Daytona sandbox's delete
    (a refused delete stops it and deletes again). The launcher is not asked to stop.
  - A kill that fails while the instance still runs throws `KILL_FAILED` (`LocalHostError`, `DockerHostError`,
    `DaytonaHostError`).
- **`archilPlace.signals`: a runner's kill request travels through the run's disk, so a box can be killed at a named crossing**
  - `Place.requestFile(attempt)` says where an attempt's runner writes its kill request; a place with `signals` has it,
    and `signals(attempt)` reads what is written there. `localPlace`'s is the supervisor's own file (`ctx.requestFile`).
  - `archilPlace`'s is `<root>/signals/kill-<attempt>.json`, in the run's directory and outside `work/`, read over S3
    every 500 ms (`signalPollMs`). The runner writes it durably (a temporary file, fsync, rename, fsync of the directory)
    or S3 may not see it. A missing object is a request not written yet; once reads have failed otherwise for
    `signalFailMs` (60 s) without a break, the iterator yields one `signals-failed` signal (`code`, `message`) and ends.
    It never rejects.
  - A request is yielded once it names `point` and `n`, with every other field it carries in `crossing`, except the
    per-attempt nonce from the supervisor's order, which is the signal's own `nonce` (`PlaceSignal.nonce`), where the
    supervisor reads it for its check. The place's token (on a disk, the mount token) never goes into a request. The
    iterator's `return()` ends a pending `next()` even while its read is in flight.
- **Places: `localPlace` and `archilPlace`, a run that a supervisor can kill and bring back**
  - Each factory returns `(ctx) => Place`, matching agentrun's reference place seam structurally: `token`, `kills`,
    `start`, `signals`, `kill`, `status`, `recover`, `release`. The package exports the types as `Place`, `PlaceRunner`, `PlaceExit`,
    `RunnerOrder`, `PlaceSignal` and `PlaceContext`, with `PlaceError` for its failures.
  - `localPlace({ app, root? })` runs `run --dir` as a child in its own process group, with no disk and no key. A process
    kill is SIGKILL to the group, and the next runner resumes the run from the directory. `release()` also ends the
    commands the run recorded, which run in process groups of their own, under the run's owner lock (while another
    process holds the run, they are its own). Given `ctx.requestFile`,
    `signals(attempt)` yields the runner's kill request (`PlaceSignal`), and the iterator's `return()` ends a pending
    `next()`.
  - `archilPlace({ disk, region, control, host })` mints each attempt's mount token itself (`token(attempt)`) and starts
    through `ensureRunning`. Its kill is the driver's `kill`. Its recovery takes the run over: the killed holder's delegations
    are revoked whatever its lease says, and the result lists them; a newer incarnation another supervisor started gets
    the usual checks instead. A runner's outcome is `run.json`, read over S3.
    `release()` stops what the place started and removes the tokens it minted; what it could not, it reports
    (`RELEASE_FAILED`) and tries again on the next `release()`.
  - `EnsureOptions.mountToken`: a start uses a token the caller minted instead of minting one, and removes it as it would
    its own when the driver starts nothing or adopts.
  - `StartAttempt.env`: what one start adds to its instance's environment. `localHost`, `dockerHost` and `daytonaHost` merge
    it over their own `env`. An order that sets PATH or PDA_HOLDER (the driver's), or a name that is not a variable name,
    is refused (`INVALID_ARGUMENT`).
- **`readLocalRunStatus(root)`: the status of a run on a local directory, from the root entry**
  - New root export `readLocalRunStatus(root)` returns the `RunRecord` of a run on a local directory (`localRun`): the same strict
    reader and the same type as `readRunStatus`, which reads a disk's `run.json` through the control API and so cannot serve a
    directory. It answers `null` for a run with no `run.json` yet (or no directory) and throws `RunRecordError`
    (`RUN_JSON_INVALID`) for a malformed record. Before, a caller had `parseRunRecord` and `RUN_JSON` from `./internals`, which
    carries no compatibility promise. The `serve-and-park` example reads its run this way, so its Since is 0.1.0-beta.15.
    Additive.
- **`seed`: what a new run starts with, written before anything sees the run**
  - `openDurableRun` and `openRunLease` take `seed: (dir: { root, storePath, workDir }) => void | Promise<void>`. It runs
    once, on the open that finds no `run.json`: inside the run's first claim, with the owner lock held, after `store/`,
    `work/` and `tmp/` exist, and before `run.json` is written and the store opens (step `seed`). What it wrote is made
    durable (the claim's barrier) before `run.json` publishes the run.
  - It never runs for a run that has `run.json`. A seed that throws fails the open with its own error, and a process killed
    while it seeds leaves the run unpublished; either way the next open seeds again. It works the same with `localRun`.
  - New types `RunSeed` and `RunSeedDir`, exported from the package and from `./lease`.
- **`withClaim` and `readReleased`: a short exclusive claim on any path of a disk, and a consistent S3 read of what it
  released**
  - `withClaim({ control, disk, region, path }, fn, options)` holds `path` exclusively while `fn` runs (pi-durable-agent's
    carry back of `agent/agent.sqlite` at a run's end). It mounts at a fresh `<mountRoot>/runs/<pid>-<uuid>`, writes `.claim`
    with its deadline (`holdMs`, 60 s), runs `fn`, then barriers, unmounts and gives its mount token back, also when `fn`
    throws.
    - A lost holder is revoked before the mount: orphaned, or holding exactly the path with an expired `.claim` that stays
      the same for 3 s. A live one within its deadline is waited for (`waitMs`, 30 s), never revoked. An abort of
      `signal` before the mount runs nothing.
    - It makes the path's directories the disk lacks (owned by the calling process, 0700, or `owner`): archil mounts no
      path whose directory is missing.
    - It refuses `INVALID_ARGUMENT` for an unsafe path or one under `runs/` or `.archil/`, `CLAIM_HELD` (76) for a live
      holder after `waitMs`, and `CONTROL_API_FAILED`. It is `FENCED` (75) when revoked from under `fn`, whose writes are
      then not durable.
  - `readReleased({ control, path }, file, { sqlite })` reads a released file over S3, with no mount: no delegation before
    or after, the object unchanged across the read, and for SQLite no `-wal` with content (`NOT_RELEASED`). It returns
    `null` when the file does not exist.
  - `CLAIM_HELD` from either is retryable: the path is not released yet. Retry within `waitMs`, and never fall back to an
    older release.
- **On a host that refuses every unmount (Sysbox, as Daytona runs sandboxes), the archil client's own bookkeeping no longer fails the release**
  - Deleting any file under an archil mount makes the client list two Active delegations of its own, `<mp>/.archil/client-<n>`
    and `<mp>/.archil/client-<n>/unlinked`. They are outside the run's tree, a checkin of the run leaves them, and a
    checkin of them fails `EROFS` once the mount is read-only.
  - The release counted them as the run's. So any run whose app deleted a file failed every release with
    `UNMOUNT_FAILED` ("still lists a delegation after archil checkin"), even after a completed run. Its instance then
    exited failed, and the restarts failed `CLAIM_NOT_VERIFIED` until the box was deleted.
  - They no longer count. Every other Active delegation under the mount still holds the run, and the mount is left where
    it is, as before.
- **`run --app`: the app's factory runs once the claim is held, so `ctx.root` is the live run directory**
  - The CLI called the app module's factory before the claim mounted, and a factory that wrote under `ctx.root` (a
    recorder's spool, a `signals/` directory) wrote into the bare mountpoint. The mount hid those writes, and the run later
    failed `ENOENT` on its own files. The claim is now taken first: the mount, the owner lock, the run's directories and
    the end of a killed incarnation's commands. Then the factory runs, then this incarnation's `run.json`, and the Harness
    opens with what the factory returned.
  - `openDurableRun` gains `afterClaim(claim)`, awaited once the claim is held and before `run.json`, with the claim's
    `ref`, `root`, `work` and `store`. Its result (`harness`, `beforeResume`, as `AfterClaim`) goes into the open, so
    `harness` is now optional in the options when `afterClaim` gives it. With neither, the open is refused
    (`INVALID_ARGUMENT`) before any claim; an `afterClaim` that returns no `harness` is refused the same way, after the
    claim. A rejection fails the open and lets the claim go. The open step is `after-claim` (`OpenStep`).
  - The open order changed, for `openRunLease` too: acquire, owner lock, layout (`store/`, `work/`, `tmp/`), the
    `commands` reap, `after-claim`, `seed` (a new run's), `run.json`, heartbeat, then store, seal and Harness. `afterClaim`
    may return a new run's `seed` (`AfterClaim.seed`), which runs over the options' one, right after it. The layout and the reap used to
    come after `run.json` and the heartbeat, and the reap ran only in `openDurableRun`. Code that reads `onStep` sees the
    new order.
  - An open that fails before `run.json` publishes nothing of its incarnation: a new run keeps no `run.json`, and a
    resumed run keeps the previous one as it was. So a module that does not load (`APP_FAILED`, exit 1, as before), or a
    reap refused by a surviving command (exit 76), reads to `ensureRunning` as a failed start: it backs off (the grace
    doubled per failure), instead of finding a fresh `running` record and starting the run again on every tick. The steps
    before `run.json` run inside the supervisor's start grace, not under the heartbeat. Claim options, if one ever needs
    them, are static (CLI flags or the environment), never returned by the factory.
- **The keyless examples run on macOS, from 0.1.0-beta.14, and say so**
  - kill-9's own check that the cut command still runs read `/proc`, so on macOS the example crashed after the kill. It
    reads `ps` where there is no `/proc`.
  - The examples index says macOS needs 0.1.0-beta.14 or later (the first release that runs there), whatever an
    example's Since says; it no longer says "Linux only".
  - The stranger's walk of the examples installs, per platform, the later of an example's Since and the spec's
    `examples.platformFloors` (macOS: 0.1.0-beta.14). Its Since alone installed 0.1.0-beta.13 on a Mac, which has no
    macOS support, and failed kill-9, audit-across-crashes and no-double-charge there.
  - The macOS CI job runs the keyless example tests (kill-9, audit-across-crashes, no-double-charge, fork-into-many,
    serve-and-park) on a Mac, and its stranger step is blocking again.
- **A start whose own writes are in the bare mountpoint is refused, `MOUNTPOINT_WRITTEN`, instead of losing them**
  - The CLI calls an app's factory before its claim mounts. A factory that wrote under `ctx.root` (a recorder, a `signals/`
    directory) wrote into the bare mountpoint. Acquire then moved those entries aside as an earlier incarnation's
    leftovers, the mount hid the rest, and the run later failed `ENOENT` on files it had written itself. Every pre-mount
    write was lost without a word.
  - Acquire now tells the two apart by time. Entries written since this process started are its own, so the start is
    refused: `ClaimError` `MOUNTPOINT_WRITTEN`, exit 65 (terminal, since a restart would write them again). The message
    names the first few as `<mp>/...` in at most 240 characters. Nothing moves aside and nothing mounts. Older leftovers
    are moved aside as before, logged by count only.
  - The check looks at every entry, since a directory keeps its time when a file in it is rewritten in place. A mountpoint
    it cannot look at whole (more than 100,000 entries, or an entry this process cannot read) may hide such a write, so it
    is refused too: `ClaimError` `MOUNTPOINT_UNCHECKED`, exit 65, naming none of the entries. Nothing moves aside and
    nothing mounts; someone looks at the directory and moves it aside by hand.
  - `ClaimError` takes an `exitCode`.
- **A place's outcome from `run.json` is in the run's word: `complete` or `failed`, not the record's status**
  - `localPlace` (without the instance's outcome line) and `archilPlace` read a runner's outcome from `run.json`. Its
    `status` was the record's (`done`, `failed`, `running`, ...), which a supervisor would have to know the package to
    read. It is now `complete` when the run is `done` and the detail of the app's last status carries a `record`, and
    `failed` for anything else: done with no record, failed, or a run its instance left `running`, `paused` or `sleeping`.
    The generation, `code`, `message`, `record` and `storeSha256` are unchanged. An outcome line the instance prints is
    passed through as it is.
- **A restart whose mount went with the failed incarnation mounts again on Daytona, and fails at once and clearly everywhere else**
  - `daytonaHost`'s launcher handed the attempt's mount token to the first incarnation only, so a restart could only reuse a
    live mount. When the failed incarnation's release had already let the mount go (always on Sysbox, where it is moved
    aside), every restart had no token and no mount. Each one then failed with archil's misleading "Authentication failed",
    until the launcher's restart limit, and the run never recovered. Every incarnation of an attempt now gets the token:
    such a restart mounts again, and after a takeover that mount is `HeldError` (76, terminal), as before.
  - Everywhere, an incarnation given no mount token (`--token-stdin` read nothing) that finds no live mount to reuse is now
    fenced at once, before any mount: `FencedError` `CLAIM_GONE_NO_TOKEN`, exit 75, terminal. It no longer loops on a mount
    that cannot succeed, and the supervisor's next start brings a new token. `localHost` keeps handing its token to the
    first incarnation only.
- **The Daytona live helpers build a runtime snapshot, so a box is ready in about 2 s instead of 16 s**
  - `test/live/daytona-snapshot.ts build <commit>` builds `pda-p9-runtime-<commit>-<stamp>` from `snapshotDockerfile`:
    `daytona-medium`'s image with the pinned Node and archil client, the run user, the wrapper, the sudoers drop-in and the
    package's dependencies. `prepareOnSnapshot` is the matching `prepare` for a `daytonaHost` start with `snapshot: <name>`:
    it puts the checkout's package source over the snapshot's `node_modules` and installs dependencies only when they
    changed. `check`, `baseline` and `delete` boot, compare and remove.
  - `build <commit> --demo` adds the disk demo's dependencies: the third-party closure of the five workspace packages its box
    installs (dsl, pi, pi-browser, pi-vision, pi-transport) and pi-codemode, pinned to the workspace lockfile at `commit`.
    `installDemoPacks` then installs the checkout's packs offline, in about 1.5 s instead of 6 to 7 s over the network;
    `check-demo` measures it and imports every entry the demo's child uses.
  - The ledger (`P9-STATE.json`) records snapshots too. A snapshot is built once under a new name, never over an existing
    one, and only one this lane built can be deleted. Every command needs the same `PDA_STATE_DIR`. A box whose delete
    failed stays open in the ledger and fails the command, and a build still running when the wait ends stays open.
  - No package code changes: `daytonaHost` already takes `snapshot` and `prepare`.

## 0.1.0-beta.14 (2026-10-16)

- **The root entry lists its exports, 134 instead of 0.1.0-beta.13's 228; the rest move to `./lease`, to a new `./internals`, or out of the package's entries.** Root values go from 136 to 46: 92 leave root (19 to `./lease`, 15 to `./internals`, 58 to no entry) and 2 are new. Who breaks: an import of one of the names below from `@parcha/pi-durable-disk`. What to do: import it from the entry named here; a name that no entry exports had no caller outside the package; open an issue if you need one.
  - To `@parcha/pi-durable-disk/lease` only (the store and lease internals): `EXIT_DATAERR`, `EXIT_FENCED`, `EXIT_HELD`, `EXIT_SOFTWARE`, `LeaseLapsedError`, `OWNER_LOCK`, `PROFILE_PRAGMAS`, `STORE_FILE`, `StoreBusyError`, `StorePragmaError`, `assertPragmas`, `exitCodeFor`, `openArchilStore`, `openRunLease`, `ownWriteFenced`, `storeHead`, and the types `OpenOptions`, `PragmaMismatch`. The classes `Fence`, `FencedDatabase`, `StoreFencedError` also come from `./lease`; the root still exports them as types, so a signature that names them type-checks.
  - To `@parcha/pi-durable-disk/internals`, a new entry with no compatibility promise (a name there can change or go in any release): `LABEL_FLEET`, `LABEL_RUN`, `RUN_JSON`, `createRunDir`, `findDelegations`, `isLeaseFresh`, `mintMountToken`, `parseRunRecord`, `pathlessResolver`, `removeMountToken`, `runPath`, `sandboxName`, `sandboxStatus`, `sweepSandboxes`, `unmountClaim`. `parseRunRecord` and `RUN_JSON` read a run's `run.json` directly, as the serve-and-park example does; `readRunStatus` (root) reads it through the control API.
  - `workspaceBarrier` and `WorkspaceBarrierOptions` are deleted: nothing installed the barrier extension, and its tests go with it.
  - `superviseRuns`, `checkHost` and `sweepTokens` are no longer exported: the `pi-durable-disk` CLI is the supported way to run the supervisor.
  - No longer exported by any entry, each still used inside the package: `ARCHIL_FSTYPE`, `CLAIM_PROBE`, `CONTROL_TIMEOUT_MS`, `DAYTONA_API_URL`, `DEFAULT_HEARTBEAT_MS`, `DEFAULT_LEASE_EXPIRY_MS`, `DEFAULT_LEASE_MARGIN_MS`, `DEFAULT_MOUNT_ROOT`, `DOCKER_PARK_THRESHOLD_MS`, `LEASE_EXPIRY_MS`, `LOCAL_PARK_THRESHOLD_MS`, `MOUNT_TOKEN_TTL`, `READ_ONLY_TOOLS`, `RETRY_CODES`, `RUN_JSON_TEMP`, `RUN_STATUSES`, `START_BACKOFF_MAX_MS`, `START_MARK`, `STONITH_TIMEOUT_MS`, `TERMINAL_EXITS`, `TOKEN_GRACE_MS`, `TOKEN_PREFIX`, `TOKEN_TTL`, `WRITING_TOOLS`, `companionsOf`, `containerStatus`, `currentBootId`, `currentHolder`, `deviceName`, `diskKey`, `isLoopback`, `loadApp`, `matchDelegations`, `parseShow`, `parseTokenNickname`, `persistRecord`, `procStartTicks`, `readRunRecord`, `readServeToken`, `readStartMark`, `recordWake`, `replaySafe`, `revokeBestEffort`, `revokeCompanions`, `runCommand`, `runDocker`, `startGrace`, `takeOwnerLock`, `tarOneFile`, `tokenNickname`, `unitStatus`, `waitDeadline`, `withTimeouts`, `writeRunRecord`, and the types `CheckReport`, `CheckStep`, `OwnerLock`, `ServeCode`, `StartMark`, `TokenSweep`, `TokenSweepOptions`.
  - New in the root entry: `archilControl`, `forkLocal`, and the types `ArchilControl`, `DiskClient`, `ForkLocalResult` (#479, #500). `TokenUser`, which `ArchilControl.listUsers()` returns, stays in the root entry.
  - `./lease` gains parking (`leaseParkTarget`, `watchParking`, `drain`, `busyState` and their types) and the types `DurableRun` and `RunEnv` that `ParkTarget` names, so a host that opened its Harness over `openRunLease` parks it without importing the root entry.
  - `test/entries.test.ts` pins every entry's values and types (`test/fixtures/entries.json`), and fails when an entry's declarations name a type of the package that the entry's caller cannot import.
- Accept pi 1.3: the `@earendil-works/pi-durable` and `@earendil-works/chord` peer ranges now end below 1.4, with the floors unchanged (1.0.4, and 1.1.0 for `@parcha/pi-browser`). pi 1.3.0 pins its own packages to exact versions, so an install is all 1.2 or all 1.3; CI runs every package's whole suite on a 1.3.0 family as well as on 1.2.0.
  - On pi-ai 1.3, a tool call whose arguments are not a JSON object reaches no tool: pi-durable refuses it and shows the model the text it sent. A durable node's `submit` then spends none of its submissions. Before 1.3 the tool ran with `{}`, so `submit` answered with the schema's violations and counted one submission.
- New export `archilControl({ apiKey, disk, region })`: one Archil disk's control API (S3 reads and writes, delegations, token users, `listUsers`), the object `ensureRunning`, `superviseRuns`, `checkHost`, `fork` and the token janitor take as `control`. A library caller composing its own supervisor, such as one driving `daytonaHost`, which `supervise` does not start, builds it without depending on the `disk` client. It is the CLI's own builder, moved and exported; `supervise` now calls it, so both get the same object. Additive.
- `beforeResume` receives `previous`: `run.json` as the run was left, before this open wrote over it, or null when there was none (a new run's first open). A host can tell how the run was left: `sleeping` with its `wakeAt` after a park, `paused` or `done` with the `detail` it set, `running` with the dead holder and no new seal after a crash, and on a fork's first open the record `fork` wrote (`paused`, generation 0, `detail.forkedFrom`). Before, the hook saw only this incarnation's `record`, whose `detail` the open has already reset to null. `RunLease` (`./lease`) has `previous` too. Additive.
- **The CLI runs on a local directory: `pi-durable-disk run --dir PATH --app MODULE`, no disk and no key**
  - `run --dir PATH` is the instance on a directory of this machine (`localRun`): the same app contract and exit codes as
    on a disk (76 when another process holds the run, or when a process its last incarnation left will not die; 75 when
    fenced) and the same run flags but the Archil ones. `--disk`, `--region`, `--mount-root`, `--archil` and
    `--token-stdin` beside `--dir` are a usage error (exit 2). `--id` defaults to the directory's name. Example 01's app
    runs as it is: `kill -9` the instance and run the same command again, and it resumes.
  - `status --dir PATH` reads `run.json` from the directory and says whether its holder is still the process that claimed
    it: `run --dir` records the instance's start ticks in the holder, so a later process that reuses the pid reads as
    `stopped`, whatever the lease says (`running`, `stopped`, or `gone` from another boot).
- **`forkLocal`: fork a run on a local directory into many**
  - `forkLocal(from, [{ id, root }, ...])` copies a released, sealed run directory of this machine (`localRun`) into one new
    run directory per target, with no disk and no mount: the copy `fork` makes, for one machine. Each fork starts `paused`
    at generation 0 with the source's `sealedSeq`, so its first open is generation 1, and goes on on its own.
  - The source is only read and stays byte for byte; every copy is made beside its target under a temporary name and none is published until all are
    complete, so a failed batch leaves nothing behind. Targets keep the source directory's owner and mode. A source that is not released and sealed is `ForkError` `SOURCE_NOT_RELEASED`, a target that
    exists is `TARGET_EXISTS`, and a target inside the source, a repeated directory or no target is `INVALID_ARGUMENT`.
  - New exports: `forkLocal` and the `ForkLocalResult` type. A run's `commands/` records are not copied.
- **A run on a local directory works on macOS, for development, and the README says what it costs**
  - `localRun`, the no-key quickstart and `run --dir` / `status --dir` run on macOS. There is no `/proc` there, so the
    process table comes from `ps` and `sysctl`: the commands a killed instance left running are recorded and ended at the
    next open as on Linux (a walk every 0.5 s, `ps -E` for a command's mark, a process told from a later one by the second
    it started), the lease watchdog kills the commands at a lapse, and `status --dir` knows its holder by pid and start.
    Before, the open threw (`/proc/self/fd`), and with no boot id the commands went unrecorded.
  - On macOS the run's root is addressed by its path (`openClaimDir`'s new `byPath`, its default there), each write
    checked first against the directory opened; `noNewPrivs` defaults to false (no `no_new_privs` there, so commands keep
    the user's rights); and the file tools are confined by path: each component opened by its full path with
    `O_NOFOLLOW`, then the path checked to still name the directory held. It refuses an agent's paths out of `work/` and
    the links in place, not a command that swaps a directory between that check and the operation. An app that passes
    `noNewPrivs` keeps its choice.
  - The store also sets SQLite's `fullfsync` and `checkpoint_fullfsync` on macOS, where `fsync` does not flush the drive's
    cache, and refuses to open (`StorePragmaError`) unless they read back.
  - `currentBootId()` and `procStartTicks()` read the same table: on macOS the boot session's uuid, and the second a
    process started.
  - A `macos-latest` CI job runs the stranger's no-key quickstart and the local run's tests on a Mac.
  - `status --dir` says `unknown` when this machine's boot or process listing cannot be read, where it said `gone` or
    `stopped`.
- `launchStatus` (and so the Daytona host's `status`) reports a launch that ended as `failed` or `stopped` as soon as the launcher has saved its final `exited` record and no instance lives, even while the launcher's own process is still exiting. It used to say `running` until that process was gone, so a status read in that moment (a supervisor poll, or the terminal-exit test under load) saw a finished launch as live. `stop` returns at once with the recorded outcome and still sends SIGTERM to a launcher process that outstays its record.
- `daytonaHost`'s in-box launcher runs when its path goes through a link. It ran its main only when `process.argv[1]` resolved to its own module path, which Node gives with links followed, so under a symlinked package directory (pnpm-style linked `node_modules`, or a link to an installed package) it exited 0 without doing anything and every start failed with "the instance ... did not start: " and no reason. It now compares the real path. And when the launcher gives no reason, the driver's error carries what it printed (its last 4 KB) or says it printed nothing; it prints only its state, never the token.
- `daytonaHost` accepts a package installed with npm: a box path may contain `@`, so `packageDir: "/opt/app/node_modules/@scope/pkg"` (and the launcher inside it) is a plain absolute path. It was refused as `INVALID_ARGUMENT`. A path with a `..` segment is now refused too; the old pattern let `/opt/../etc` through.
- A dead FUSE mount caught while its daemon's connection is being torn down now reads as dead. Right after a `kill -9` of the daemon, the stat that decides "dead" can be in flight, and the kernel ends it with `ECONNABORTED`; only a stat issued after the teardown gets `ENOTCONN`. `unmountClaim` (and so `release` and the takeover paths) and the local host driver's `stop` counted only `ENOTCONN`, so such a mount read as live: `UNMOUNT_FAILED`, or a dead mount left behind. Both now read either code as dead and clean the mount with `fusermount -u`; any other stat error still reads as live, and a live mount is still never forced.
  - The local host driver decided "dead" by matching the English text "Transport endpoint is not connected" in `stat`'s stderr, which coreutils translates, so under any other locale a dead mount read as live. It now runs the stat in a child that prints the errno code, and the check reads that code (`DEAD_CONNECTION`, exported from the claim module); messages are never read.
- The acceptance rig builds the supervisor's control API with the package's own `archilControl` (the one the CLI uses) instead of a hand-kept copy. The copy had no `exec`, and without `exec` a delegation the control API lists with no path (a dead client's private directory among them) cannot be attributed, so every supervisor pass on a disk that lists one refused with `CONTROL_API_FAILED`. The rig now starts runs on such a disk.
- The live suites' runner (`test/live/ci.ts all`) no longer exits 13 instead of 1 when another live run holds the lock: its
  lock holder stays referenced until the lock is decided, so a refused holder whose pipes close before its exit event no
  longer leaves the process with nothing to wait on and its top-level await unsettled.
- A local live runner, `test/live/ci.ts all`, for the ship skill to run before a change to this package ships: `npm run build && node packages/pi-durable-disk/test/live/ci.ts all` under a credential wrapper that exports `ARCHIL_API_KEY`, `PDA_LIVE_DISK` and `PDA_LIVE_REGION` for a scratch organisation and a scratch disk. It refuses to start without the key (the suites would otherwise skip and pass), runs the host suites and then the Docker suites, each under a deadline, always sweeps what a cut suite left (its systemd units, containers and mounts on the host, then its run directories and token users on the disk), prints the suites' timings, and ends on `ok: live disk check passed (...)` or `not ok: <step>: <reason>`. `all --slow` adds `supervise-slow`, the three supervise tests that wait out fixed windows (about 17 minutes), now a file of their own. The live suites now give their run directories the running user's uid rather than 1000.
- **An example: fork one run into many**
  - `examples/fork-into-many` runs on directories of this machine with pi-ai's faux model (no disk, no key, Linux). An agent
    drafts a note and the run is released at that checkpoint; `forkLocal` copies the sealed run three times, and each fork
    opens as generation 1 with the checkpoint's conversation and files, takes its own instruction and finishes. The source stays
    byte for byte. It ends with one `ok:` line, and `test/examples/fork-into-many.test.ts` runs it on every change.
- **An example: a coding agent that survives `kill -9`**
  - `examples/kill-9` runs on a directory of this machine with pi-ai's faux model (no disk, no key, Linux). An agent writes
    files in `work/`, is refused a write outside it, and starts a long `bash` command; the process is `SIGKILL`ed in the
    middle of it. A second process opens the run, which ends the command the first left running; the files are intact, the cut
    command comes back `interrupted` and is not run again, and the agent finishes. It ends with one `ok:` line, and `test/examples/kill-9.test.ts` runs it on every change.
- New example, `examples/no-double-charge/` (`node examples/no-double-charge/main.ts`): a paid call that never double-charges across a `kill -9`, with no disk and no key. A fake payment server in the example counts charges by idempotency key and holds invoice 2's charge in flight while the agent is killed. The run reopens in a second process, the cut `charge` call comes back `interrupted` and isn't sent again, and the server ends with one charge per invoice. `test/examples/no-double-charge.test.ts` runs it in CI.
- New example, `examples/planned-move/`: a run moves from this machine (a systemd unit) to a Daytona sandbox at a step boundary, by hand-over and not take-over. The first incarnation sets `paused` with where it is going and releases (sealing the store); the supervisor starts it in a box with `ensureRunning(..., { demand: true })`, which revokes nothing; the second incarnation's `beforeResume` reads `previous` and tells the agent it moved before any step resumes. It needs an Archil scratch disk, a Daytona key and a host set up for production, and the same run user uid on both hosts. Its test skips without the keys.
- **An example, `serve-and-park`: an idle agent holds no process**
  - An instance serves `POST /submit` on a directory of this machine. Its model is overloaded and pi retries after a long
    wait, so the run parks: `run.json` says `sleeping` with `wakeAt`, the claim is released and the process exits 0. A
    small restart loop opens the run again at `wakeAt`, the retry finishes, and a repeated `requestId` is answered with the
    first submission instead of running again. No disk, no key: `node examples/serve-and-park/main.ts` after the build,
    with pi-ai's faux model. A test runs it in `npm test`.
- **Examples say which published version they need, and how to run one from an install**
  - `examples/README.md` gains a "Since" column (the first published version that has what each example imports) and a
    "Run one from an install" section: an empty directory, `npm init -y && npm pkg set type=module`, the README's install
    line, the example's files, `node main.ts`. `fork-into-many` and `planned-move` need 0.1.0-beta.14 or later (`forkLocal`,
    `archilControl` and `beforeResume`'s `previous` are not in 0.1.0-beta.13, where they stop at their import); each example's
    README states its version. Checked by running each keyless example against the published 0.1.0-beta.13.
- The failure table gains a Docker host and a Daytona host lost before the instance reaches running: a start still in the
  driver fails typed and tries to remove what it made (attempted, not guaranteed: on Docker a removal that fails is left
  for the operator to find by its `pda.run` label; on Daytona the box's TTL bounds it), no failed start is counted, and
  the next tick starts again; a start that had
  returned is held `starting` by the start mark until the start grace passes, then started again (revoking an orphaned
  delegation first). Nothing is lost, since an instance writes `run.json` at its generation before it opens the store.
  Timings are cited from the live suites where measured, and marked not measured on Docker and Daytona.
- The README quotes the refusal an open writes when a process a killed incarnation's commands started will not die
  (`COMMANDS_ALIVE`), for one survivor, word for word; a test builds the message from the code and fails if the README's
  copy differs.

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
