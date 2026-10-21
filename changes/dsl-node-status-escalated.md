---
packages: @parcha/agentrun-dsl
kind: feature
---
`nodeStatus` takes the run's terminal result, `{ pin, items, result }`, and marks where an escalation stopped the run: the escalate node that fired and every container on its path are `escalated`. The driver's frame holds no mark for a fired escalate node, so from the frame alone that node read `not-run` and its containers `working` after the run had ended. A map or loop on that path has ended, so what finished inside it is done. The escalation's node is read from `result.escalation.executionPath`, as `runWorkflow` returns it, or `result.escalation.node`. `NodeState` widens with `escalated`: a reader that switches on every state adds the case. Without a result, the status is byte for byte what it was.
