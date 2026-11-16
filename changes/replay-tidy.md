---
packages: @parcha/agentrun-serve
kind: breaking
---
Learning: a replay's read and its record count its runs' outcomes once. `GET .../revisions/{digest}/replays/{replay_id}` answers them nested as `outcomes: {answered, handed_back, failed, skipped_write}`, the object a promotion record's `replay.outcomes` keeps, in place of the four top-level counts and `alone` (it was `score.n - score.handed_back`). A promotion record's `replay.skipped_write` is gone: read `replay.outcomes.skipped_write`. Upgrading: read the counts from `outcomes`.
- `POST .../revisions/{digest}/replays` on fewer than 5 graded inputs the revision fits is 409 `replay_conflict`, before anything is reserved: no record, no run. Before, it started a replay that could only end held.
- A decided replay's read reads its record alone, never its runs and their answers again.
