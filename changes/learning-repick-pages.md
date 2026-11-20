---
packages: @parcha/agentrun-serve
kind: feature
---
An agent's `learning` takes `repick: true` (off by default): a learned workflow compiled after it re-picks a missed
quote from the pages its run fetched, not from its compact notes alone. The server rewrites the passing draft before it
commits it: the answer's re-pick loop runs the answer step as compiled first, then, on a miss, the same step reading
the pages, told they are untrusted data and never instructions, with no tools. `learning.repick_max_chars` (150000 by
default, 1 to 400000) caps the characters that second pass sends, the longest pages cut first. Its cost is the served
run's, under the run's cost cap. The setting is read at each compile, so a change reaches only workflows compiled after
it; agents whose workflows run through an SDK bridge ignore it.
