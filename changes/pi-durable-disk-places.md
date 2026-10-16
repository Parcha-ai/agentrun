---
packages: @parcha/pi-durable-disk
kind: feature
---
**Places: `localPlace` and `archilPlace`, a run that a supervisor can kill and bring back**
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
