---
packages: @parcha/agentrun-serve
kind: fix
---
An ended run whose end could not read its booking now heals by the end's own rule: a booking that holds a charge at its hold heals as an upper bound (`cost.upper_bound: true`), so `GET /v2/usage` and `GET /v2/runs/{id}` read the same figure, and the store writes it only over an unknown cost with no bound. The start sweep no longer rereads runs that can never heal (a native run, a person's stop of an agentic run, a run with no booked answer), so the `cost_heal` line's `read` counts only runs that could. SQLite and Postgres alike; no schema change.
