---
packages: @parcha/agentrun-serve
kind: fix
---
Run ids minted in one millisecond now list and claim in creation order: every run id comes from the monotonic UUIDv7 minter uploads already use, so two runs started in the same millisecond list newest first and a runner claims the older first. Before, a run id's bits after its time were random, and such runs listed and were claimed in either order. A purge on SQLite now writes its scrub marker (`store.sqlite.scrub`) before it changes a row, so a full disk refuses the `DELETE` (500 `internal`) with nothing purged and the retry purges whole. A retried `DELETE` of a purged run or agent does no checkpoint and writes nothing. A purge that commits and then fails (a Postgres commit left unanswered) no longer keeps the run's answer and input in the server's memory.
