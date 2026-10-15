---
packages: @parcha/pi-durable-disk
kind: docs
---
The failure table gains a Docker host and a Daytona host lost before the instance reaches running: a start still in the
driver fails typed and tries to remove what it made (attempted, not guaranteed: on Docker a removal that fails is left
for the operator to find by its `pda.run` label; on Daytona the box's TTL bounds it), no failed start is counted, and
the next tick starts again; a start that had
returned is held `starting` by the start mark until the start grace passes, then started again (revoking an orphaned
delegation first). Nothing is lost, since an instance writes `run.json` at its generation before it opens the store.
Timings are cited from the live suites where measured, and marked not measured on Docker and Daytona.
