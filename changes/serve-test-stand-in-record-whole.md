---
packages: @parcha/agentrun-serve
kind: ci
---
`packages/serve`: the recovery tests' stand-in run writes `run.json` whole, through a temporary file and a rename, as a run does. A plain rewrite let the server's 500 ms read land on a half-written record, read it as no record, and settle the adopted run early, which failed "an adopted run that released is read only once its process has exited" about once in a loaded full run.
