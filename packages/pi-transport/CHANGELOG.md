# Changelog

## [Unreleased]

## 0.1.0-beta.28 (2026-10-28)

- The launcher has its own subpath, `@parcha/pi-transport/launch` (`./home` still exports the same names), and a launched program no longer inherits the box runtime's environment. Its environment is PATH, HOME, LANG (`C.UTF-8`), `PI_TRANSPORT_INCARNATION` (the incarnation, from 1) and the spec's `env`; a program that read a variable of the box's own lists it in the new `inheritEnv` (default `false`). Who breaks: a caller of `launch` whose program relied on a variable set on the box (`BoxSpec.env`, or the provider's runtime). What to do: name each such variable in `inheritEnv`.
  - `env` refuses a key-shaped name (a `_`-separated segment KEY, TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL or CREDENTIALS) by name, never its value, and PATH, HOME, LANG and every name the launcher sets: `env` rests in a file of the box and never holds a secret. `env` and `inheritEnv` also refuse every variable the C library itself strips in secure mode (glibc's `UNSECURE_ENVVARS`, such as `GCONV_PATH`, `GLIBC_TUNABLES` and `LOCPATH`, and musl's `MUSL_LOCPATH`; `TMPDIR` excepted) beside `LD_*` (`env` is exported before a root launcher drops to `user`), the launcher clears them at the exec that starts its shell, and it reads only `/proc` (no `PI_TRANSPORT_PROC`).
  - A launch has a handle, `Launch` (`{ v: 1, name }`, JSON with no secret), on its state as `state.launch`; `launchState(box, launch, ctx)` and `launchStop(box, launch, options, ctx)` take it, beside `launchStatus` and `stopLaunch` by name. The state also reports `incarnation` and `restarts`.
  - `Box.launcher` (optional, new on the `Box` interface): a box that keeps a program alive natively (a test's fake box) answers the three calls itself; they read it on every call. A provider leaves it undefined.
  - A launch's `stdin` (disk's mount token) is replayed to every incarnation, and its `secrets` reach every incarnation on one fd (`PI_TRANSPORT_SECRETS_FD`), both on ONE path: the launch frame on the stdin of the exec that starts the launcher, held only in the launcher's memory, never in a file of the box, an environment, an argv or the state. Only a box with `secretsVia: "fd"` takes them (new optional `BoxFacts.secretsVia`, absent meaning no channel: `unsupported`); `local` and `docker` report `fd`.
  - `user`: who the program runs as. A root launcher drops to it (`setpriv` or `runuser`); a launcher that is not root runs the program only as itself. A launch with `stdin` or `secrets` whose program is not root needs the box's ptrace scope at 1 or more, measured in the box.
  - `toolsUser`: with a program run as root, the user it runs everything it does not trust as. A launch with `stdin` or `secrets` runs as root only with one. The launcher verifies it in the box (it exists, is not root and has not the root group, has no sudo rule, and can run no setuid or setgid root file and no file with capabilities), the program gets `PI_TRANSPORT_TOOLS_USER` and `PI_TRANSPORT_TOOLS_UID`, and the state reports it. Each getcap line is read to its file whatever its form (several capability groups, `path = caps`, a path with spaces), and a line that names no file is `unsupported`. The check takes at most 60 s, and a start's call to the box (a revive's too) is given that and its usual 30 s on top, so the check ends inside the call. What the launcher cannot measure is the host's guarantee (README).
  - A stop is one stop's: a second stop at the same time waits for the first and never kills before its `beforeStop` hook ends, a stop whose first one died takes it over, and a `launch` of the name during a stop waits for it. The phase is `stopping` meanwhile. Every stop returns the state of the incarnation it stopped, as the launcher recorded it before it released the name, never a launch of the name that started after it, and a stop that reaches the box only after such a launch took the directory leaves that launch alone (when the host and the launch's launcher.sh are both of this version: a host that passes no generation, or a launch an older launcher.sh runs, keeps the old behaviour, where a late stop can still act on a later launch of the name).
  - `launchSpecError(name, spec)`: the spec's own check, pure (no box, no I/O): the same `invalid` error `launch` gives, for a host that asks before it makes a box to launch in. `launch` asks it first.
  - The launcher's spool (`.pi-transport-launch` in the box's `TMPDIR`) and each launch directory must be the launcher's uid's alone: a directory, never a symbolic link, owned by that uid, with no group- or other-write bit; every directory above the spool, up to `/`, must be root's or that uid's, never a symbolic link, with no group- or other-write bit unless it has the sticky bit (`TMPDIR` is read as the directory it names). Every call checks them before it uses them, and the launcher checks them again before each process it starts from them and before a stop's hook. A local box makes its own `home`, `tmp` and `pids` directories mode 700. A failed check is `unsafe`, and nothing runs from the directory. The box also needs `ls`.
  - New `LaunchErrorCode`s: `unsupported` (a spec the box cannot honour), `refused` (a box setting that would expose what a launch holds) and `unsafe` (a spool or launch directory another user could change).
- A box can be asked for a network, ports and FUSE, and its facts say what it has: `BoxSpec.network` (`"open"`, `"none"` or `{ allow: [...] }` of domains, wildcard domains and IPv4 CIDRs), `BoxSpec.ports` (each `https` by default, or `tcp`) and `BoxSpec.capabilities` (`["fuse"]`). A provider that cannot give one refuses the spec with `unsupported`; a malformed value is `invalid`.
  - `BoxFacts` gains six optional fields, `network`, `ports`, `diskGb`, `startedAt`, `fuse` and `ptraceScope`, so a custom provider needs no change. An absent field never grants anything: `fuse` absent is `false`, `network` and `ports` absent are unknown (a caller that must be sure of `none` or of no exposed port refuses), `ptraceScope`, `diskGb` and `startedAt` absent are unknown. `readFacts(facts)` reads them that way.
  - `Box.endpoint(port, context)` (optional) returns where an exposed port is reached: an `https` URL, or a `tcp` host and port, never a provider's id.
  - `modalBoxes` implements all of it: `network` and `ports` map to Modal's network and tunnel parameters; `capabilities: ["fuse"]` starts a `vm` and checks, as root in the box, that `/dev/fuse` is a character device that root can open (the mount is root's), ending a box that fails the check; `diskGb`, `ptraceScope` and `fuse` are what the box reports. `dockerBoxes` takes `network: "none"`. `localBoxes`, `daytonaBoxes` and the Archil exec box refuse anything but `open`.
  - The box conformance suite checks the facts that are present.
  - `modalBoxes.attach` of a live sandbox always returns the handle and never ends the box: the facts are read again (a failed read is retried three times); a read that answers gives them as measured (a box with no usable FUSE reads `fuse: false`, and the caller ends it through the handle); if every try errs, the handle keeps the hardware the create measured, kept in a tag, and every security fact (the Yama setting, the network, the ports) is left out as unknown; a box whose tag holds nothing measured (made before the tag) gets an `unknown` attach error instead, and keeps running. A failed workspace setup on attach is an attach error too (never an ok handle on a box that may have no workspace).
- `fakeBoxes()` in `@parcha/pi-transport/testing`: a fake box provider for testing a host against the `Box` contract with no machine, key or network. It records every call (argv, env names, stdin bytes, files, spec, typed result) and `leaks(marker)` finds a value in anything recorded. A test scripts outcomes by rule (a typed failure, a delay, a hang, a lost end of an empty stdin, a dropped or truncated stream, a scripted exit, a box that ends mid-call, a create that fails but leaves its box findable by `list`) on a `fakeClock()` that moves only when told. Programs are functions a test registers; a box's files are in memory. Each fake box fills `Box.launcher`, so the launcher's own `launch`, `launchState` and `launchStop` run over it with a scriptable state, the restart policy, the stdin replayed to every incarnation, and the stdin and secrets recorded on the launch call only. The `modalLike()` and `daytonaLike()` presets are included; the `startedAt` and `ptraceScope` facts they report are extra until the box contract carries them.
- A Modal box reports `secretsVia: "fd"`, so a launch can carry a stdin and secrets to it: the launch frame rides the stdin of the exec that starts the launcher, and no value goes in an argv, the `env` or `secrets` parameters, a tag or a fact. The provider is trusted with the box; whether it keeps an exec's stdin is undocumented, and no claim is made about it.
  - Behaviour change: a `close()` of a Modal program's input that fails while the program still runs is now returned by `wait()` (an `unknown` error naming the input), where it was ignored; a close that fails on a program that already exited is still ignored. A second `close()` of the same input (a launch closes it after the frame, and `finish` closes it again) is no failure: the input is closed once, tracked by the adapter itself.
- A Modal box's `facts().gpu` is the GPU it was served, not the one asked for: the model `nvidia-smi` names in the box (a bare `H100` may be served an H200), one name for identical cards and every model, joined by ` + `, for a mixed box. A box that asked for a GPU and reports none fails the create and is ended. On attach the read runs again and the box is always handed back: a model named is the fact, none named reads `gpu: null` (the caller ends it through the handle), and when every try errs the handle keeps the model measured at create, kept in the box's tag, or the attach is an error for a box whose tag has none. The meaning of a published fact changes (it was the request): a caller that compared `facts().gpu` with its spec now compares with the model's name. Docker still repeats the request, and its documentation says it is not measured.
- The launcher's check of a tools user (`toolsUser`) walks its mounts by filesystem type and no longer fails on a pseudo filesystem. It walked every mount without `nosuid`, so `/proc`, where a process ends mid-walk, made `find` exit non-zero and the check refuse the launch (seen on a VM whose `/proc` has no `nosuid`). The kernel's pseudo filesystems (`proc`, `sysfs`, `cgroup`, `cgroup2`, `devpts`, `mqueue`, `securityfs`, `debugfs`, `tracefs`, `bpf`, `pstore`, `configfs`, `fusectl`, `binfmt_misc`, `efivarfs`) are skipped, and every other type, an unknown one, `tmpfs` and `devtmpfs` included, is still walked, so a setuid root file on any of them is still refused. The walk ignores an entry that vanishes mid-walk only where `find` takes `-ignore_readdir_race`, found by running it; a `find` without it keeps the strict walk and a vanished entry stays `unsupported`, as does every other `find` error.

## 0.1.0-beta.26 (2026-10-24)

- An empty write, append or upload no longer waits on a stdin end that `docker exec -i` can lose. `boxEnv`'s `writeFile` and `appendFile` with no bytes, `uploadByExec` of an empty file and `moveFile` of a sealed file of no bytes now read their input from `/dev/null` in the box (`exec </dev/null;` in front of the script) and send nothing over the exec's stdin. Before, one empty call in about 2,700 on Docker never got its end of input, the box's `cat` waited for it, and the call ended at the operation timeout as an `unknown` file error. A non-empty write is unchanged. This sits in `boxEnv`, so it covers every provider with an exec stdin.
- The README's first example is a local box that needs no key and no Docker daemon (the Docker one follows it), prints its output as text, and every snippet that uses `BACKGROUND_CONTEXT` imports it. The `transport()` example runs by itself on a scripted model and a local box, the ownership example uses a temporary directory, and the README says what Jev is and that the examples are ES modules with the pi peers installed.

## 0.1.0-beta.23 (2026-10-22)

- `archilExecBoxes({ client, disk })` (`@parcha/pi-transport/box/archil-exec`): boxes that are directories of an agent's
  Archil work disk, each `exec` one serverless Archil call (about 100 ms warm, measured in us-east-1). The SDK is the
  host's (`Archil` and a disk from the `disk` package), not a dependency. The limits are stated, not hidden: `BoxFacts` gains
  optional `maxExecMs` (300 000: a longer `timeoutMs` is `invalid`) and `liveProcesses` (`false`: no stdin, output after
  the call, no program kept between calls). A box with `liveProcesses` false is never a home: the box place refuses it with
  `MoveError` code `no_live_processes`. Every exec checks out the box's directory with a queue, so a second process on the
  same box waits instead of losing a write; a box's record is a file outside the directory, so `destroy` ends the box at once
  even while a command runs. The conformance suite takes `withoutLiveProcesses: "<why>"` and leaves out the live-program and stdin cases,
  with one case in their place that carries the reason, and `withoutEnv: "<why>"` for a box that has no env: Archil's exec carries only the command, so a spec with an env is refused with `unsupported` (the record and every call's command carry none) and a `boxEnv` per-call env on such a box is refused. A box billed per call gets a receipt with `calls` and `usd_per_call`
  in place of `usd_per_second` (`BoxPrice` takes `usdPerCall`; RECORDING.md draft 40). The live suite
  (`PI_TRANSPORT_LIVE_ARCHIL=1`) makes its own disk in aws-us-east-1 and deletes it.
- The README gives an install line, in "A box": the package with its pi peers pinned at 1.3.0 (`@earendil-works/pi-durable`,
  `@earendil-works/pi-ai`, `@earendil-works/chord`). pi 1.4.0 is npm's latest and outside the package's peer range, so an
  install that names the peers without a version stops with ERESOLVE; pi 1.4 is not supported yet, and a later release
  widens the range.

## 0.1.0-beta.21 (2026-10-21)

- `@parcha/pi-transport` is on npm under the beta tag: the guide and the harness README give the install line, `npm install @parcha/pi-transport@beta`, and a demo that declares `boxes` without it installed says to run that line, no longer that the package is not on npm.
- The package's npm description now names what it does: a pi agent's tools on this machine, in Docker, or in a Daytona or Modal sandbox, behind one `Box` interface, with Jev placing each step. It no longer says the session moves.

## 0.1.0-beta.20 (2026-10-20)

### Added

- A box the hands environment found lost answers `exec` with the provider's `BoxError` (code `gone`) as the `ExecutionError`'s `cause`; the code stays `unknown`, as pi has no `gone` code.
- `BoxFacts.bulk`: how large amounts of bytes move fastest into and out of a box, through the streams of `exec` or as files through `upload` and `download`; absent means files. `localBoxes` and `dockerBoxes` say `stream`.
- The movers (`./home`): `sealStore`, `checkpointStore` and `verifyStore` for a SQLite store, and `manifestOf`, `moveWorkspace` and `moveFile` for a workspace that travels between boxes as a `tar` stream, with a manifest taken in the box.
- Ownership (`./home`): `leaseIn`, `Ownership`, `ConditionalStore`, and `dirStore`, a store in a directory whose write is `link(2)` of a complete temp file; `registerStoreConformance` in `./testing`.
- The `Box` and `BoxProvider` interfaces, with `BoxError` codes.
- `localBoxes` (`./box/local`) and `dockerBoxes` (`./box/docker`).
- `registerBoxConformance` and `createBoxConformance` (`./testing`), 19 cases. The lifetime case takes an `ended` probe that looks at the machine and not at the provider.
- The strict `transport` config: `parseTransportConfig`, `TransportConfigSchema`, `parseDuration`.
- `boxEnv` (`./hands`): pi's `ExecutionEnv` over a `Box`, so a session's tools run in a box.
- `transport()` (`./hands`): a Harness's `env` from a parsed config. Boxes are created at first use, found again
  after a restart, shared by the session or kept for each conversation, and let go with `release` or `destroy`.
  `HandsDoc`, `SessionBoxesDoc` and `TransportError` are exported from the package root.
- `boxEnv`'s `onLost` option: called once when the environment finds its box gone.
- `launch`, `launchStatus` and `stopLaunch` (`./home`): keep a program alive in a box whatever happens to the host. A small `sh` supervisor, uploaded with `Box.upload`, restarts the program when it exits (with a restart limit and terminal exit codes), keeps its output to a bounded tail, and reports its phase from a state file (`lost` when its launcher is gone). It needs `sh`, `setsid`, `sed`, `cut`, `awk`, `wc`, `tail`, `date` and `sleep`, and runs on Debian, Alpine and a VM whose init never reaps.
- `probeAcknowledgedWrites` (`./testing`): whether a write a program was told was durable survives that program's death, so a runtime can be checked before it holds a session's disk.
- `openHome` (`./home`): one place a session runs, driven by orders (`resume`, `drain`, `seal`, `reopen`, `retire`). Its
  gate holds a running session still for a move with nothing cut, or opens again and names what held it. An app is
  `(ctx) => options` without `env` and `models`, so one module runs on the host and in a box.
- `modalBoxes` (`./box/modal`): a Modal sandbox (gVisor) or VM (`isolation: "vm"`) per box, over a Modal SDK the
  host passes in.
- Each provider is the entry `./box/<name>`, from one pattern export; `./box/box`, `./box/child` and `./box/files`
  are not entries.
- `daytonaBoxes` (`./box/daytona`): a Daytona sandbox per box over the REST API, sized by its snapshot; the key stays
  in the host.
- A workspace or file copy no longer reports a stall while a side is still starting. The stall limit ("no byte moved")
  was running during each side's setup (the parts directory, the program's start), so a box that took longer than the
  limit to answer one call cut a healthy copy with `timeout` after 0 bytes; the hold is now taken before the first call
  and kept until the side is up. The default limit is 60 s, so only a smaller `stallMs` on a slow box was exposed.
- Accept pi 1.3: the `@earendil-works/pi-durable` and `@earendil-works/chord` peer ranges now end below 1.4, with the floors unchanged (1.0.4, and 1.1.0 for `@parcha/pi-browser`). pi 1.3.0 pins its own packages to exact versions, so an install is all 1.2 or all 1.3; CI runs every package's whole suite on a 1.3.0 family as well as on 1.2.0.
  - On pi-ai 1.3, a tool call whose arguments are not a JSON object reaches no tool: pi-durable refuses it and shows the model the text it sent. A durable node's `submit` then spends none of its submissions. Before 1.3 the tool ran with `{}`, so `submit` answered with the schema's violations and counted one submission.
- The link of a home in a box (`./home`): `connectHome` on the host, `createRunner` and `runMain` in the box, frames
  over the box's own `exec`. The runner's models mirror the host's catalog and hold no credential; the host answers
  each request, refuses one from an epoch the lease left behind, and keeps an answer's frames so a link that drops
  costs no second request (`connectHome`'s `server`: one `serveModels` server for every link to a runner). An order
  the host gives up on is cancelled in the runner, and one whose context ended already is not sent. The runner says
  ready only with its home open. A line longer than `maxLineLength` (64 Mi characters by default) closes a link.
  `@earendil-works/pi-ai` is a peer dependency, `*` like every package Pi provides.
- `moveHome` and `recoverHome` (`./home`): a session's home moves between boxes with no shared disk in seven
  steps, the take of a numbered lease the one point of no return; a host that starts again finishes the move from
  the lease, which keeps the move's id and the seal; the store keeps the workspace it last ran in. A home holds its
  store alone: a second runner at the same place is `busy`, and `recoverHome` stops a runner still running there first
  (`stopRunner`). `boxRunner` starts a runner in a box over its own `exec`. A session can move back to a place it left.
  Recovering a home sealed at the lease's epoch first takes the next epoch for that place, so it moves the epoch; when a
  move took that epoch first, recovery is `lost`, opens nothing, and says where the lease puts the session.
  `registerMoveConformance` (`./testing`) kills the host, the source or the target before each step.
- The model link no longer imports its frame encoder from pi-ai, which removed it in 1.3.0 (`@parcha/pi-transport/home`
  failed to load there). The package carries its own `FrameEncoder` and `applyFrame`, written to the same wire format as
  pi-ai 1.1 and 1.2 wrote, byte for byte: frames kept at rest and a home on an older build still link. The format is
  pinned by streams captured from pi-ai 1.2.0 (text, thinking, tool calls, an error and an abort) as test data. Peer
  ranges are unchanged.
- The tests of "a phase that moves no byte is not a stall" no longer race on a loaded machine: once a slowed setup call ends, tar has the stall limit to move a first byte, and 25 or 400 ms is less than the spawn of a real process can take on a busy runner (a failure of the form "no byte moved for 25 ms, after 0 bytes" on other pull requests). The limit is now one second and the slowed phase is three times that, so the claim is tested with no scheduling noise. Tests only.
- `boxEnv`'s abort and timeout no longer leave a command running when the call that kills it fails. The kill call's result used to be dropped, so a kill exec that failed fast or timed out on a loaded provider API left the command's process group running in the box after `exec` had answered `aborted` or `timeout`, and nothing ended it later. The kill now reads back that no live process of the group is left (a zombie is not counted: `kill -0` succeeds on one, and in a container whose first process does not reap, a killed group would have stayed "alive" for ever), and the call is sent again at 1, 2 and 4 seconds when it fails, times out or finds the group alive, within 10 seconds of wall time, a call in flight included. A stop whose kill call worked answers as fast as before; one that needed a retry answers later, by at most 10 seconds.
  - A new optional property on that error: when no kill call could confirm the group gone within the bound, the `aborted` or `timeout` error is a `StoppedCommandError` (new type, exported from `@parcha/pi-transport/hands`) with `killUnconfirmed: true`, and the command stays tracked so `cleanup()` ends it with the rest. It is absent when the group was confirmed gone.
  - The live and local tests of "the whole process group is killed on an abort and on a timeout" now poll for "not running" with a bound that fails, instead of reading absence once right after `exec` returns.
- A session whose box is gone is rebuilt in a new one from a checkpoint the host holds (`./home`). `pullCheckpoint` takes
  one moment of a session off its box: it holds the session briefly, copies its store and pulls the files that changed
  since the last checkpoint into a vault (`localVault`: three generations by default, hard-linked, so a generation costs
  its delta). A checkpoint is whole or skipped, with a reason (`busy`, `changed`, `too_large`, `failed`) that
  `checkpointStats` counts, with how long the session was held. `workspace.exclude` leaves paths out (never pulled, named in
  the restore notice), and `maxPullBytes` bounds one pull. `recoverHome` takes a `vault` and the host's `replace()`: when the
  lease's box is gone (never on a timeout), it restores the newest checkpoint that still checks out into the box `replace`
  makes, takes the lease at the next epoch, and tells the model once what did not survive and which calls ran since. With
  no usable checkpoint it fails with `no_checkpoint` and changes nothing.
  - The commits between checkpoints are kept too: `recordSink` implements the record stream's sink over the vault
    (`appendLog`, `readLog`, `through`), and a restore replays the unbroken run through the store's own `Storage` before the
    Harness opens, so what the lost box admitted after the checkpoint is in the history the new box opens. The resume order's
    `move` carries `kind`, `head` and `replayed`.
  - `serveModels` keeps a paid answer by the request's `key` until a checkpoint covers it (`covered(head)`), so a rebuilt
    runner's repeat is answered without paying again; `proxyModels({ keyOf })` makes the key.
  - New in `./home`: `pullCheckpoint`, `localVault`, `recordSink`, `checkpointStats`, `restoreNotice`, `replayCommits`,
    `manifestSince`, `moveChanged`, `excludedOf`. New in `./testing`: `registerRestoreConformance`, which kills the whole box
    of the source or the target before each step of a move and recovers.
  - Crossings: named moments a place announces, awaited, so the host can act exactly there (a supervisor kills a box or a
    process). `pullCheckpoint({ crossing })` announces `transport.checkpoint.taken` once the checkpoint is the latest and the
    session is let go (never for a skipped pull); `connectHome` / `boxRunner({ crossing })` announce `transport.tool.started`
    with the tool's name when a tool begins, and the runner holds the tool until the handler returns, `info.release()` is
    called, or `crossingMs` (10 s) passes. `crossingCounter()` keeps `n` across restarts. Nothing is killed by this package.
- The placer: `jevPlacer` asks Jev through pi-ai's `Models.classify` where a session's next step should run (one call,
  `need` against the resting place and `where` among the environments) and moves it only for a need; every decision is
  a `PlacementRecord` by `jev` or `config`, kept in the session's store (`transport.placements`) with
  `HomeHandle.recordPlacement`. It refuses to build without the classifier model or its key. The config gains
  `environments.<id>.purpose`, `auto.rest` and `auto.threshold`. `./testing`: `replayClassifier` and
  `recordingClassifications`.
- The record stream (`./home`): a host that passes `connectHome`'s `records` (a `RecordSink`) keeps the session's log.
  The runner puts each commit in an outbox beside its store before the store has it, ships its writes and its
  recorder's lines (`runMain(app, { recording })`) once it has, sends what the host lacks on every connect, starts no
  effect the host's log lacks (`admitsTool`, `admits`), seals only what the host holds (`not_shipped`), and keys each
  model request by its generation (`key`, `position`). `registerMoveConformance` takes `records: true`.
- The box-env offline tests no longer leave a `sleep 3600` running after a run: a test that held a process group of its own ended the shell that started it, not the group. The file now marks its own process, so every child it starts carries the mark, and an after-all check fails the file, naming each process it left behind, if any survives it.
- `./place`: `boxPlace(options)`, a session's place in a box for a supervisor that starts, kills and restarts it. It
  starts pi-transport's runner in the box (`boxRunner`), kills a runner by its process (`killRunner`, KILL first) or by
  its box, restarts it in the same box or, for a lost box, in a new one from the newest checkpoint, or before any checkpoint from the vault's log alone
  (`recoverHome` with `restoreFromLog`),
  takes checkpoints at rest (`pullCheckpoint`), reads a runner's kill request and the transport's crossings
  (`signals`), ships every runner's commits into the vault's log (`recordSink`, the host's `recorder` takes the lines)
  and asks one model server for all of them, names every box by its label (the host's `receipts` ledger's numbering)
  in its status, its crossings and its own `transport` lines (`lines`: `box.created`, `box.killed`, `box.ended`, `lease`,
  `restore`), keeps the host's placement decisions in the session's store (`recordPlacement`), reports the run's status, carries the files an order names back from the box (`carry`), and brings a
  recording written in the box home when its supervisor asks (`recordHome`, `clockSkewMs`).
  The app contract gains `AppContext.env` (the session's environment, from `ResumeOrder.env`, over the link), `root` and
  `epoch`, and `onResumed`, called once the session has resumed and not awaited by the order; `recoverHome` and
  `moveHome` take `env`, a home keeps the environment it last opened with for an order that brings none (a reopen),
  `boxRunner` takes `onProcess`, and a home refuses an order whose `env` is not names to strings (`invalid`).
- `boxReceipts({ prices, write })`: a ledger of the boxes its wrapped providers make, with one receipt per box when it
  ends (destroyed, found ended, or gone): `{ box, provider, kind, from, to, seconds, usd_per_second, cost_usd, source,
  priced }`, for the host to write as a live `transport` line of kind `box.receipt`. `box` is a label, never the
  provider's id: a host's `label(made)` is called when the box is made, with its own request and facts, and `taken`
  carries the labels a recording holds across a restart. The prices are the host's, and a box with no price writes no
  receipt. A box found ended after it expired is counted up to its maximum lifetime, not to when it was found.
  `cost_usd` is an estimate at list price, not the provider's invoice. `labelOf(provider, id)` says the label a
  box was given, and wrapping a provider the ledger already wraps returns it. It comes from the package root;
  `./box/receipts` is not an entry.
- A move's durable record: the target writes the document `transport.moves`, keyed by the move id, once, in the first
  commit it makes when it opens the moved store (`MoveRecord`, `MovesDoc`), from what the host sends in
  `ResumeOrder.move.record` (`MoveFacts`). `moveHome` sends the places, its drain, ship and take times, its bytes and
  its seal; its `head` is the seal's. A home `Place` takes a `label`, the name a recording gives its box
  (`whereOf(place)`), and the box place passes its boxes' labels. An order with no record writes none.
- A session whose box is gone can be restored from the host's log alone (`./home`): `recoverHome({ ..., restoreFromLog: true })`, when no
  checkpoint checks out, replays every shipped commit from the first into an empty store, gives the new box an empty workspace and takes
  the lease at the next epoch. A job that never rests takes no checkpoint, so before this its whole-box loss was `no_checkpoint`. It needs
  a log whole from commit 1, is off by default, and the model is told that no checkpoint existed and no file came back.
  `restoreNotice(undefined, ...)` makes that text.
- `@parcha/pi-transport` is published: its manifest no longer says `"private": true`, so a release publishes it after `@parcha/pi-vision` and before the reference host. The package is unchanged; the box interface, the `local` and `docker` providers, the home movers and the conformance suite are what they were in the repository.
- The README's first screen says what the example shows: a pi agent's tool calls go to Daytona and Modal sandboxes, and Jev places each one on the sandbox that fits it. The API (`boxEnv`, `transport()`) and the providers table follow it, and the transport config section moves under the tools in a box, where it belongs. The root README, `AGENTS.md` and a new short section of `docs/guide.md` ("Run an agent's tools where each step needs them", with a keyless example on local boxes) say the same, with all four providers.
