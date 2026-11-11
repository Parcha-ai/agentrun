---
packages: @parcha/agentrun-serve
kind: fix
---
Archiving a run that is already archived keeps its first `archived_at`: `POST /v2/runs/{id}/archive` again is a no-op, never a new time (#2080). A message to an archived run, or to a run of an archived agent, is refused `409 not_continuable` in words that say it is archived (`details.reason` `archived`, `details.archived` `run` or `agent`), with the way back (unarchive the run or its agent) as its `next_action`. Before, it said the run was "finished".
Upgrading: nothing to do.
