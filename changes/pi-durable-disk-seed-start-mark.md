---
packages: @parcha/pi-durable-disk
kind: feature
---
**A seed of any length stays in the supervisor's start grace**
- While a new run seeds it has no `run.json` heartbeat, and `ensureRunning` keeps a start in its grace only while the
  start mark (`runs/<id>/start.json`) is younger than the grace (90 s by default). A longer seed was taken as a failed
  start: revoked, then seeded again.
- Now, while the seed runs, the instance rewrites the mark's `at` every heartbeat through its claim (fsync and rename).
  It does so only when a supervisor's mark for generation 1 is there, keeping its generation, `by`, `failures` and
  `lastExit`. The rewrite runs on a thread of its own, one at a time, so a seed that blocks its thread (a synchronous
  import) stays covered. It stops when the seed ends, before the open goes on, and `run.json`'s heartbeat takes over.
- A seeder that dies stops rewriting, and the grace runs out as for any start. The mark's format does not change.
