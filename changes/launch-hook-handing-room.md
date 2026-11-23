---
packages: @parcha/agentrun-serve
kind: fix
---
Launch hook: a firing the server is still handing over, or whose run the host is starting, now holds its trigger's room as a run in progress. Before, with `max_active_runs: 1`, a late host start for a firing waiting on its retry could land while another firing's hook was still open; both runs then started. That late start is now refused with 422 `not_due`, naming the cap, and two host starts at once for one place start one run and refuse the other. Without `max_active_runs`, the overlap check skips for the firing being handed, naming it.

A host start for a firing its host took with no run now holds the room until its run is written, however long the write takes. When `start_by` is less than a minute away, the server also moves it to a minute after the start began, before it writes the run, so a later firing can no longer be handed while that run is being written. A start that fails without writing its run moves `start_by` back.

Two host starts of the same firing at once now start one run: the second answers the first's run with 202 and `idempotent-replayed: true`, and a firing whose host's start is still writing its run is not handed to the hook again. The room check reads the trigger as it is at the check, so a start whose earlier read predates another firing's run no longer takes that run's place.
