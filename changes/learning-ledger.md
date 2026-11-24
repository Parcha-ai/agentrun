---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
Learning cost now has a single source of truth, a ledger. The store writes one ledger row for each run, plus spend rows for each compile, check and audit, filed under the workflow version they were for. An agent's cost page (`GET /agents/{id}/learning/cost`), a run's cost (`GET /runs/{id}`) and the launch's money rule all read one summary of those rows, so they agree on every figure. The money rule had its own cost formula and its own by-hand baseline; both are deleted.
- New fields, all additions: a run's `cost` and the cost page's `runs[]` gain `compile_usd`, `followup_usd`, `shadow_usd` and `share_usd`, the parts that make up the run's `learning_usd`. `runs[]` also gains `not_served`: `"cost_stop"` when the money rule stopped the workflow, `"cut"` when a restart cut the workflow's call and the run was handed back (the summary counts that in `hand_backs.cut`, never `back`), or null. Existing fields keep their names and meaning.
- The money rule's by-hand side is now the job's own cost, the cost page's `before`, instead of an all-in mean over the newest 500 runs. The line where a workflow counts as over the by-hand cost moves to match.
- A revision's compile spend stays on that revision even when no promote record names it. Such a revision now shows on the bill at the default K instead of falling into unattributed.
- Postgres stores apply migration 0027, which adds the `learning_ledger` and `learning_spend` tables and is additive. On SQLite a server adds them at its start, and a runner waits for that server. A run that ended before the upgrade gets its ledger row worked out from its run row when it is read.
