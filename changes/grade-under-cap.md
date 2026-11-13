---
packages: @parcha/agentrun-serve
kind: fix
---
A run's grade of what it learned runs under what the run's cap leaves, so a capped run never goes past its cap by its grade.
- When a capped run that learns ends, its learning run gets its own cap: the run's cap now (a raise counts), less what the run spent (its job, its follow-ups, every look-back) and what each earlier round's grade spent. An uncapped run's grade is capped by nothing, as before.
- Each grader call is checked against that cap before it is sent, at its worst case: its whole input uncached and its whole output bound. It is never cut down to fit, so a verdict is never lost to a short answer.
- A grade that doesn't fit is not sent. The run's learning ends `dropped` with reason `no_budget` and the words "Not graded: no room under the cap." (or "Not graded: the grade's cost can't be kept under the cap." when its spend or the grade model's price is unknown), which the run page shows. It is a skip, not a failure, and spends nothing.
