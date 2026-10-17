---
packages: repo
kind: fix
---
`examples/web`: a run in an imported home reads its timeline from its store. A pack carries no `run.json`, so the runs server answered 409 ("the run is live") for every run of a home made by `importPack`; a run whose entry in the home's index has an `endedAt` was carried back at its source, so the server now treats it as released with or without `run.json` and gives its timeline, state and cost from its store. A run with no `endedAt` and no `run.json` is still not read from its store.
