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
