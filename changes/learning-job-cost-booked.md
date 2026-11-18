---
packages: @parcha/agentrun-serve
kind: fix
---
A learning pi run that compacted its context two or more times now reads its stored cost on `GET /runs/{id}` and in `GET /agents/{id}/learning/cost`, instead of `cost.usd: null` beside a known figure and a count in `unknown_cost_runs`. The job's cost its learning keeps (`job_cost_usd`) is read from the run's booking by the same rule its end stores its cost by, so with no compile turn after the job it is the stored cost, and a compile turn's spend is that cost less the job's.
