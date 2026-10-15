---
packages: @parcha/pi-durable-disk
kind: feature
---
**Places: `localPlace` and `archilPlace`, a run that a supervisor can kill and bring back**
- Each factory returns `(ctx) => Place`, matching agentrun's reference place seam structurally: `token`, `kills`,
  `start`, `kill`, `status`, `recover`, `release`. The package exports the types as `Place`, `PlaceRunner`, `PlaceExit`,
  `RunnerOrder` and `PlaceContext`, with `PlaceError` for its failures.
- `localPlace({ app, root? })` runs `run --dir` as a child in its own process group, with no disk and no key. A process
  kill is SIGKILL to the group, and the next runner resumes the run from the directory.
- `archilPlace({ disk, region, control, host })` mints each attempt's mount token itself (`token(attempt)`) and starts
  through `ensureRunning`. Its kill is the driver's `kill`. Its recovery takes the run over: the killed holder's delegations
  are revoked whatever its lease says, and the result lists them. A runner's outcome is `run.json`, read over S3.
- `EnsureOptions.mountToken`: a start uses a token the caller minted instead of minting one, and removes it as it would
  its own when the driver starts nothing or adopts.
- `StartAttempt.env`: what one start adds to its instance's environment. `localHost`, `dockerHost` and `daytonaHost` merge
  it over their own `env`, PATH and PDA_HOLDER stay the driver's, and a name that is not a variable name is refused
  (`INVALID_ARGUMENT`).
