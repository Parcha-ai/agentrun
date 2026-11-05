---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /usage`: a run whose cost is unknown (a model request a restart cut, a paid call a crash cut, a provider with no price) adds what it is known to have spent so far to the total and its lines, and is still counted in `unpriced_runs`. A total is never below a line of its own (a run's browser time no longer drops out of the total), and with `unpriced_runs` above 0 it is a lower bound.
