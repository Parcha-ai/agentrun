---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: breaking
---
The Learning tab shows the owner's bill: run after run, what the agent has cost with learning (every run that does a job, its look-back, grade, audit shadow run and its share of its workflow revision's check, booked dollars only), cumulative, against the agent doing all of it (the mean of its own runs before the first promotion, times the runs), with a break-even marker where the bill falls to that line and stays, or "not yet" with the gap. Under it, the audit line (agreement over the hold window and all time, each hold at its run) and the serving workflow's nodes with their tiers, code checks and the check it was promoted on.
  - `GET /agents/{id}/learning/cost` has `bill`: its points, the baseline, the first promotion, `break_even` or `gap_usd`, the runs withheld, and each revision's check spend as its next `compile_after` served runs carry it, with what no run carries yet (`unattributed_usd`).
  - `GET /runs/{id}` has `path` and `cost.learning_usd` and `cost.all_in_usd`: what learning spent for the run elsewhere (its grade, its audit's shadow run, its share of its revision's check) and the two together. Every run's `all_in_usd` plus the bill's `unattributed_usd` is the bill's total.
  - A shadow run is in no run list, sends no webhook and is no run of `GET /stats` or the analytics' counts; its cost stays in their dollars.
  - The server has `deleteLearning`, the learning half of an agent's delete: the learning folder (its git history and audits.jsonl) and the agent's promotion, grade and eval records, refused while learning work is in flight, and safe to call again after a crash.
  - Upgrading: `cost.usd` on a served run is now its own spend; its audit shadow's cost moved to `cost.learning_usd`. Read `cost.all_in_usd` for the figure `cost.usd` was.
