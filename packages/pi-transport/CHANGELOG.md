# Changelog

## [Unreleased]

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
