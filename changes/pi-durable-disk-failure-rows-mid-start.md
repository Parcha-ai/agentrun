---
packages: @parcha/pi-durable-disk
kind: docs
---
The failure table gains a Docker host and a Daytona host lost before the instance reaches running: a start still in the
driver fails typed and leaves nothing behind (no failed start counted, the next tick starts again); a start that had
returned is held `starting` by the start mark until the start grace passes, then started again (revoking an orphaned
delegation first). Nothing is lost, since an instance writes `run.json` at its generation before it opens the store.
Timings are cited from the live suites where measured, and marked not measured on Docker and Daytona.
