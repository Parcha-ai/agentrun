---
packages: @parcha/agentrun-serve
kind: fix
---
The server's start sweep of ended runs whose stored cost is unknown no longer reads, at every start, the runs whose cost can never heal from their booking: a native run, a person's stop of an agentic run, and a run with no booked answer stay unknown and are left out, so the `cost_heal` line's `read` counts only runs that could heal. A run with a booked request whose booking still gives no exact figure (a charge of no known cost, a hold) is still read, since only its booking says so. The store's heal writes a figure only over an unknown cost with no bound beside it, on SQLite and Postgres alike; no schema change.
