---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
A run's timeline only grows: a row it has shown stays, in its place, across a woken run's processes. A woken run rebuilds its live rows from the conversation's current view, which after a compaction no longer holds the messages the summary replaced, so those messages and their answers used to disappear from `/v2/runs/{id}/timeline`. Only live rows (a stream, a wait, a run phase) are dropped when they end. `timelineReducer` gains `isLive(id)`, which tells such a row from one a committed entry made.
