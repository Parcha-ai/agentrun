---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow's `llm` call is paid once and its tokens count. Each call completes on the run's marked models, so its cost is already a `REQUEST_COST` entry the run's cost sums, and serve added it again from the node log. The run's cost, the cost its end stored, its graph's total, `/v2/stats` and Mission Control all showed it twice; now each counts it once, and the cap, which already counted it once, is unchanged. That entry now also carries the completion's tokens as pi counts them (`input`, `output`, `cacheRead`, `cacheWrite`; none when pi counted none), so an `llm` call's tokens and a compaction summary's are in the run's metrics, once, rather than unmetered.
