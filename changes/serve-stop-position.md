---
packages: @parcha/agentrun-serve
kind: fix
---
A stopped run stays stopped until the person sends another message, whatever happens to the messages it shows. The stop is kept as a place in the run's store (`stopped_at` in the run's `serve.json`: the stopped message's id, or place 0 when the stop came before any message), and the run reads stopped while no message shown is newer. Before, it was a count of the messages shown, which a compaction changes. Now a run stopped and then compacted stays stopped, even when the compaction summarized the stopped message itself. A run that was sent a new message and then compacted back to the stop's count no longer reads as stopped. A stopped run whose compaction summarized every message it showed reads `input_required`, not `queued`. A stop the run refuses leaves nothing saved. A run stopped by an older server (`stopped_after`, a count) reads as before.
