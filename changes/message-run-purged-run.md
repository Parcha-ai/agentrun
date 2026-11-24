---
packages: @parcha/agentrun-serve
kind: fix
---
A `message_run` trigger whose run was purged (`DELETE /runs/{id}`) now turns itself off at its next firing, as one whose run is gone does: disabled with `source_unreadable` and "its run was deleted", the firing skipped with that reason, and no failure counted, including when the purge lands while the firing's message is on its way. A purge keeps the run's row as a tombstone, so the check for a missing run never saw it: the firing went on to the run, failed, and counted toward the trigger's pause. A `message_run` trigger can no longer be made on a purged run or moved onto one either (`422 not_found` under `target.run_id`).
