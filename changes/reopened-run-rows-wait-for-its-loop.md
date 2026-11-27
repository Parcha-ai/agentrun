---
packages: @parcha/agentrun-serve
kind: fix
---
A run a grade or a message opened again right after its end, on the runner that ended it, gets that grade or message in its first turn. Before, the runner handed the run's new rows to its loop while its earlier claim was still letting go and its loop had not started: a run in its own process left the follow-up for a later claim, and an in-process run could start without it, so a grade's round read running for good.
