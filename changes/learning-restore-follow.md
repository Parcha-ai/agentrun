---
packages: @parcha/agentrun-serve
kind: fix
---
A learned note a person retired by editing its status, or created already retired, says it was retired by a person, not a run. A restore reads the retire it undoes from a commit's subject alone, never a line in a message body. Restoring a workflow draft runs the learning checker over its workflow.json (its tools and the gate's settings, as a run's merge does), so a draft no run could run stays retired. A note that a person's approval or restore of another supersedes says `last_change.kind: "superseded"`, not the other note's action.
