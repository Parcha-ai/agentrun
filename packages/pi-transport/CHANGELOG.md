# Changelog

## [Unreleased]

### Added

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
- `openHome` (`./home`): one place a session runs, driven by orders (`resume`, `drain`, `seal`, `reopen`, `retire`). Its
  gate holds a running session still for a move with nothing cut, or opens again and names what held it. An app is
  `(ctx) => options` without `env` and `models`, so one module runs on the host and in a box.
- The link of a home in a box (`./home`): `connectHome` on the host, `createRunner` and `runMain` in the box, frames
  over the box's own `exec`. The runner's models mirror the host's catalog and hold no credential; the host answers
  each request, refuses one from an epoch the lease left behind, and keeps an answer's frames so a link that drops
  costs no second request (`connectHome`'s `server`: one `serveModels` server for every link to a runner). An order
  the host gives up on is cancelled in the runner, and one whose context ended already is not sent. The runner says
  ready only with its home open. A line longer than `maxLineLength` (64 Mi characters by default) closes a link.
  `@earendil-works/pi-ai` is a peer dependency, in the same range as pi-durable.
- `modalBoxes` (`./box/modal`): a Modal sandbox (gVisor) or VM (`isolation: "vm"`) per box, over a Modal SDK the
  host passes in.
- Each provider is the entry `./box/<name>`, from one pattern export; `./box/box`, `./box/child` and `./box/files`
  are not entries.
- `daytonaBoxes` (`./box/daytona`): a Daytona sandbox per box over the REST API, sized by its snapshot; the key stays
  in the host.
