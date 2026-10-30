---
packages: @parcha/agentrun-kernel
kind: feature
---
`AdapterSession.settleOpenTurn()`: a turn a crash cut off can be ended instead of resumed. It is recorded ended `interrupted`, the submission that opened it is withdrawn when the turn never placed it, and nothing is sent to the harness, so no later open resumes it. Any other submission pending then reached the session meanwhile and is the next turn's input; a settle again, with no turn cut since, withdraws nothing. It is written once, in the shared adapter session, so every harness adapter has it; the faux harness in `./testing` has it too. Only an open turn is settled.
