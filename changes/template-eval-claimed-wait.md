---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: fix
---
A template eval no longer gives up on a run a runner holds just because its first rows haven't shown yet. A run's view reads `queued` until then, and the eval used to cancel any run still `queued` after 2 minutes, saying "no runner took it (state working)" about a run a runner had claimed. Now, when a run reads `queued` past that limit, the eval checks the run's `claim`. While a runner holds the run, the limit starts again and the run gets its own 30-minute limit. A run no runner holds is cancelled with "the run stayed queued for 120 s with no runner holding it". `agentrun template eval` now passes a stop on to the eval through the same code as the other server commands. A launch that fails, or a signal it didn't pass on, is now explained, as for those commands.
