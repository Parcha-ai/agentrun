---
packages: @parcha/agentrun-serve
kind: fix
---
A learned workflow whose `workflow.json` a purged run changed last is refused by every read, however old its merge: its file read is `410 purged`, a champion read by its digest reads no commit, a later merge's diff shows the file as added (never the purged text), an SDK start sent again whose receipt pinned it is `410 purged`, and no run lays or serves it, so the agent takes the run. Before, the file read, the diff, an SDK receipt and a run's seed served the purged text, and a champion read served it once the merge was older than the log's newest 200 changes.
