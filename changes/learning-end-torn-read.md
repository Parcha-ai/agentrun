---
packages: @parcha/agentrun-serve
kind: fix
---
A run's learning that settles while it is read (GET /runs/{id}/learning, GET /sdk-runs/{id}) no longer reads merged or dropped with the proposal's time as its `at` once, then the learning run's end time on every read after. The learning run's row was read before its journal, so its last save could land between the two; the row is now read again when the journal holds an end the row had not seen.
