---
packages: @parcha/pi-transport
kind: feature
---
A session whose box is gone is rebuilt in a new one from a checkpoint the host holds (`./home`). `pullCheckpoint` takes
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
