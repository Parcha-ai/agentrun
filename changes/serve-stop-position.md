---
packages: @parcha/agentrun-serve
kind: fix
---
A stopped run stays stopped until the person sends another message, whatever happens to the messages it shows. The stop is kept as the stopped message's id (`stopped_at` in the run's `serve.json`), never a count of the messages shown, which a compaction changes: a run stopped and then compacted no longer reads as working, and a run sent a new message and then compacted to the stop's count no longer reads as stopped. A run stopped by an older server (`stopped_after`, a count) reads as before.
