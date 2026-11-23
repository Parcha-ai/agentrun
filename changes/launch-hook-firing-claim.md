---
packages: @parcha/agentrun-serve
kind: fix
---
Launch hook: a firing a server is handing over, or whose run the host is starting, now holds its trigger's room for every server on the same store, not only the one doing the hand. The server writes a short claim on the firing (new nullable columns `trigger_firings.claimed_until` and `claimed_by`; Postgres migration 27, added at server start on SQLite). Other servers count a claimed firing as a run in progress and leave it to the server that holds it. The claim goes when that server is done, or lapses after a minute if it stops. Before, with `max_active_runs: 1`, a host start on a second server could start a run while the first server's hook was still open, and a second server could hand the same firing again.

Two servers' host starts of the same firing no longer stack their `start_by` pushes. Only the start that holds the firing's claim moves `start_by`, and a start that fails without writing its run moves it back to the value it replaced.

A host start whose run is written, but whose firing could not be marked started because the store did not answer, now has the firing started with its run as soon as the store answers again (tried at once, then on each tick). Before, a firing the host took with no run stayed that way. Once its `start_by` passed, the run no longer counted toward `max_active_runs`, and later firings could start past the cap.

Without `max_active_runs`, a firing driven while another firing of the trigger is being handed over now waits for that hand instead of being skipped. If the hand starts no run, the waiting firing starts. A firing waiting on another that is being handed is no longer driven again at each wait poll, and a firing whose host start is writing its run is no longer driven by the timer meanwhile.
