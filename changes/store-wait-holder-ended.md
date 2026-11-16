---
packages: @parcha/agentrun-serve
kind: fix
---
On SQLite, a begin, write or statement whose wait for the write lock ran out while the process was held up, on a transaction of the same process, no longer fails StoreBusy when that transaction's commit is read before the wait's busy answer: it waits on and lands. Two connections' answers come back in no set order, so the holder was looked for after it had let go.
