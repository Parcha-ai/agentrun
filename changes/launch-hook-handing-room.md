---
packages: @parcha/agentrun-serve
kind: fix
---
Launch hook: a firing the server is still handing over, or whose run the host is starting, now holds its trigger's room as a run in progress. Before, with `max_active_runs: 1`, a late host start for a firing waiting on its retry could land while another firing's hook was still open; both runs then started. That late start is now refused with 422 `not_due`, naming the cap, and two host starts at once for one place start one run and refuse the other. Without `max_active_runs`, the overlap check skips for the firing being handed, naming it.

A host start that begins just before a firing's `start_by` now holds the room until its run is written. When `start_by` is less than a minute away, the server moves it to a minute after the start began, before it writes the run, so a later firing can no longer be handed while that run is being written.
