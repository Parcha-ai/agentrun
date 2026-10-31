---
packages: @parcha/agentrun-dsl
kind: fix
---
A frozen run now records how many question answers came back with no price, so its recorded spend is read as incomplete rather than as a bare total that silently omits them. Before, an answer whose cost was null (or any non-finite or negative number) added nothing to `questionSpendUsd` and left no other trace, so the run's question spend read as a complete number that dropped the unpriced answer. An unknown cost is never zero.
- The driver keeps `unpricedQuestionCount` beside `questionSpendUsd`, committed in the same save, and a resume that skips a finished unpriced question still reports it. A reader of the run's spend that finds the count non-zero has the known sum and the fact that it is incomplete.
- A refused `recordQuestionSpend` (an answer for a node that is not a route, or a route already decided) now leaves the snapshot untouched, so a later save never carries a half-recorded answer forward.
- The frozen checkpoint gains an optional `unpricedQuestionCount` (a non-negative integer). The checkpoint schema is unchanged, and a checkpoint written before this change has no count and opens as before.
