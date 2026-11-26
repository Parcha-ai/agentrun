---
packages: @parcha/agentrun-import
kind: feature
---
`parseHome`'s `threads` defaults to the cores less one, at most 16, and no more than free memory holds at each worker's heap; it was the cores, at most 8. Copilot CLI's `events.jsonl` is read on the pool like the other line sources, and OpenCode, whose sessions are database rows, is read on the calling thread. `workerOldMb` must be at least 8 (a RangeError under it). Pass `threads` to pin the count.
