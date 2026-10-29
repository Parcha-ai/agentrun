---
packages: @parcha/agentrun-kernel
kind: feature
---
`AdapterSession.settleOpenTurn()`: a turn a crash cut off can be ended instead of resumed. It is recorded ended `interrupted`, input sent for it and not yet placed is withdrawn, and nothing is sent to the harness, so no later open finds the turn open again. It is written once, in the shared adapter session, so every harness adapter has it; the faux harness in `./testing` has it too. Only an open turn is settled.
