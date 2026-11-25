---
packages: @parcha/agentrun-serve
kind: fix
---
A change for callers: an approval's note (`POST /runs/{run_id}/approvals/{approval_id}`) is now cut of the keys the run holds before it is written into the run, as a message is. A run whose launch's sealed part won't open under this server's seal key now refuses a note with `409 not_continuable`, `details.reason` `withheld`, and nothing is written. Before, the note was written whole, so a deny note that repeated one of the run's keys kept it in the run's command rows, and the run's view showed it once its end erased the key. An answer with no note is taken as before. A grade's `label` (`PUT /runs/{run_id}/grade`) goes through the same cut and refusal. A graded run has ended, and its end erased what it held, so this matters only for a launch that still holds sealed values.

`template eval` no longer cancels a run at one claim read that finds no runner when a runner already took the run and its view later reads queued again (a workflow run between steps, a run waiting for a place after a cap raise, a steer not yet taken). A page that isn't queued now counts as the run held, so the queue bound starts over from there.
