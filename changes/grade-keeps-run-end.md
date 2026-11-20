---
packages: @parcha/agentrun-serve
kind: fix
---
A run's look-back (its own after its job, or the feedback round a grade opens) keeps the run's end: GET, the list, SSE and the console show it completed (or failed) with its answer and `ended_at` while its learning reads `reflecting`, polled until it settles, and it tells `run.ended` once. Stop and cancel refuse it then, and a runner-side stop or cancel that lands mid-round drops only the round, so a graded run is never left cancelled or stopped. A runner lost during the look-back leaves the next one the same end at the same time. `PUT /runs/{run_id}/grade` during a look-back is `409 run_learning` (a new error code), nothing kept: grade the run once its learning moves on from `reflecting`. The console shows no Grade form then, and says why.
