---
packages: @parcha/pi-durable-disk
kind: feature
---
**`readLocalRunStatus(dir)`: the status of a run on a local directory, from the root entry**
- New root export `readLocalRunStatus(dir)` returns the `RunRecord` of a run on a local directory (`localRun`): the same strict
  reader and the same type as `readRunStatus`, which reads a disk's `run.json` through the control API and so cannot serve a
  directory. It answers `null` for a run with no `run.json` yet (or no directory) and throws `RunRecordError`
  (`RUN_JSON_INVALID`) for a malformed record. Before, a caller had `parseRunRecord` and `RUN_JSON` from `./internals`, which
  carries no compatibility promise. The `serve-and-park` example reads its run this way, so its Since is 0.1.0-beta.15.
  Additive.
