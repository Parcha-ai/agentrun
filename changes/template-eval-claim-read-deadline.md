---
packages: @parcha/agentrun-serve
kind: fix
---
`template eval`: the read that asks whether a runner holds a queued run now stops at the run's deadline. Its own bound is still 10 s. Before, a read that stalled near the deadline could push the run's cancel up to 10 s past it.
