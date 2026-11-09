---
type: llm
---
Check the score is the rubric's computation over the criteria the brief lists, not a judgment. Read `fit.criteria`,
`fit.computation` and `fit.score` in the answer's last fenced `json` block, and recompute it yourself from
`fit.criteria` alone:

1. Each criterion's `weight` is 2 for `must`, 1 for `nice`, 0 for `disqualifier`.
2. `total_weight` = the sum of `weight` over the `must` and `nice` criteria.
3. `met_weight` = the sum of `weight` over the `must` and `nice` criteria whose `met` is `true`.
4. `raw` = round(100 × met_weight / total_weight), halves up; 0 when total_weight is 0.
5. Caps that hold: 60 when any `must` has `met` `false`; 10 when any `disqualifier` has `met` `true`; 10 when `flags`
   holds `competitor` or `student`. A disqualifier with `met` `false` or `"unknown"` is no cap.
6. The score = the least of `raw` and the caps that hold.

Also read each disqualifier's `criterion` and `met` as one sentence against its evidence: a disqualifier written as a
negation ("is not a gambling operator") or whose `met` says the opposite of its own evidence is inverted.

Pass only if all of these hold:

- Your recomputed `total_weight`, `met_weight`, `raw`, caps and score equal those in `fit.computation`.
- `fit.score` equals `fit.computation.score` and your recomputed score.
- No disqualifier is inverted.

Say the numbers you computed, then pass or fail. Whether each `met` is right for the lead is the other grader's job;
this one checks only that the arithmetic and the caps follow from the list as written.
