---
packages: @parcha/agentrun-serve
kind: fix
---
A `DELETE` of a run or an agent retried after its purge committed and could not write the SQLite scrub marker (the 500 `internal` a full disk answers) now arranges the scrub again: it answers 204 as before, and it also runs the purge's WAL checkpoint again, writing `store.sqlite.scrub` when another connection still holds the log back, so the next start's scrub truncates it. Before, the retry answered 204 and wrote nothing, and the log could keep the purged bytes until some later checkpoint. A `DELETE` of a purged run or agent with the marker already there writes nothing new, and an agent's retried `DELETE` also drops the purge-in-progress mark its failed one left.
