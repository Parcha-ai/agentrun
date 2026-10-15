---
packages: @parcha/pi-durable-disk
kind: feature
---
**`archilPlace.signals`: a runner's kill request travels through the run's disk, so a box can be killed at a named crossing**
- `Place.requestFile(attempt)` says where an attempt's runner writes its kill request; a place with `signals` has it,
  and `signals(attempt)` reads what is written there. `localPlace`'s is the supervisor's own file (`ctx.requestFile`).
- `archilPlace`'s is `<root>/signals/kill-<attempt>.json`, in the run's directory and outside `work/`, read over S3
  every 500 ms (`signalPollMs`). The runner writes it durably (a temporary file, fsync, rename, fsync of the directory)
  or S3 may not see it.
- A request is yielded once it names `point` and `n`, with every other field it carries (a nonce the supervisor
  checks). The iterator's `return()` ends a pending `next()` even while its read is in flight.
