---
packages: repo
kind: feature
---
The reference example's child is also an app module for `pi-durable-disk run --app` (`examples/reference/child-app.ts`), so a run has one open path with the disk package's claim, fence, stdin mount token, run.json holder and restarts. On `done` the run's final status carries the record and the store's hash. `run()` is now built from `compose()` (the registry, models and the steps after the open) and the entry's child from `prepareChild()`, which the app module shares.
A run is keyed by its demo's name (the place's `paths.id`, passed to the child as `RUN_ID`), not a fixed `reference`, so two demos never share a run; `pathsAt` and `placeAt` take the id. Under `pi-durable-disk run --app` the id is the instance's `--id`: pass the demo's name.
