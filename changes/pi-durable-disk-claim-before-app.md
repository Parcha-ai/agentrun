---
packages: @parcha/pi-durable-disk
kind: fix
---
**`run --app`: the app's factory runs once the claim is held, so `ctx.root` is the live run directory**
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
  `commands` reap, `after-claim`, `run.json`, heartbeat, then store, seal and Harness. The layout and the reap used to
  come after `run.json` and the heartbeat, and the reap ran only in `openDurableRun`. Code that reads `onStep` sees the
  new order.
- An open that fails before `run.json` publishes nothing of its incarnation: a new run keeps no `run.json`, and a
  resumed run keeps the previous one as it was. So a module that does not load (`APP_FAILED`, exit 1, as before), or a
  reap refused by a surviving command (exit 76), reads to `ensureRunning` as a failed start: it backs off (the grace
  doubled per failure), instead of finding a fresh `running` record and starting the run again on every tick. The steps
  before `run.json` run inside the supervisor's start grace, not under the heartbeat. Claim options, if one ever needs
  them, are static (CLI flags or the environment), never returned by the factory.
