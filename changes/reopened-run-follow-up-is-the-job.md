---
packages: @parcha/agentrun-serve
kind: fix
---
A learning run that a follow-up opened again now counts the follow-up's turns as the job's. Its `cost.usd` is everything the run spent except each round's end-of-run turn, its `cost.tools_usd` holds the follow-up's paid calls (`toolsusd/3`), and `GET /v2/runs/{run_id}/usage` serves its `tools`, `browser_time` and other lines (`runusage/5`) instead of `lines: null` with `reason: "reopened"`. The lines at each end are cumulative: they hold the last end's lines and what the follow-up added, so a backend that bills each end bills the difference. Before, `usd` stayed at the first round's figure, `tools_usd` was null and the follow-up's spend was booked as learning (`followup_usd`), so a backend billing the job charged nothing for a follow-up's paid tools. `followup_usd` now holds only end-of-run spend beyond the compile turns. A reopened run's ledger row gets the new figure at its next end; a run that already ended keeps the row it has.
