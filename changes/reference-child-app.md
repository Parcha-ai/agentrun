---
packages: repo
kind: feature
---
The reference example's child is also an app module for `pi-durable-disk run --app` (`examples/reference/child-app.ts`), so a run has one open path with the disk package's claim, fence, stdin mount token, run.json holder and restarts. On `done` the run's final status carries the record and the store's hash. `run()` is now built from `compose()` (the registry, models and the steps after the open) and the entry's child from `prepareChild()`, which the app module shares.
A run is keyed by its demo's name (the place's `paths.id`, passed to the child as `RUN_ID`), not a fixed `reference`, so two demos never share a run; `pathsAt` and `placeAt` take the id. Under `pi-durable-disk run --app` the id is the instance's `--id`: pass the demo's name.
The supervisor puts `DEMO_ENTRY` (the demo's entry module) and `DEMO_NAME` into every order's env, so a place that starts the child through the app module needs no wrapper.
A process run by `pi-durable-disk run --app` writes nothing under the run's directory before its claim is open: the recorder, the fetched sources, the box, the ledger and event logs and the judge's count start in `beforeResume`, and a recording line produced earlier is kept in memory and written in order when the recorder starts.
