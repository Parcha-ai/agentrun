---
packages: @parcha/pi-durable-disk
kind: feature
---
`beforeResume` receives `previous`: `run.json` as the run was left, before this open wrote over it, or null when there was none (a new run's first open). A host can tell how the run was left: `sleeping` with its `wakeAt` after a park, `paused` or `done` with the `detail` it set, `running` with the dead holder and no new seal after a crash, and on a fork's first open the record `fork` wrote (`paused`, generation 0, `detail.forkedFrom`). Before, the hook saw only this incarnation's `record`, whose `detail` the open has already reset to null. `RunLease` (`./lease`) has `previous` too. Additive.
