---
packages: @parcha/agentrun-serve
kind: fix
---
A call that waited for approval now reads in order on the Timeline: the call, held for your approval; your approval; then what came of it. Once the run is resumed, the call's own rows say "Held for your approval", and the outcome is the resume row below the approval row: "AgentRun: <tool> ran once you allowed it; its result went to the agent", or "…was refused: you declined it[: <note>]". Before, the call's row said the outcome above the approval it came from. Before the resume row is in, the call's rows still say what came of the approval; an allowed call that ran says "Ran once you allowed it; its result went to the agent". The order holds in a run with several approvals: answering a later one leaves an earlier call reading held. Upgrading: nothing to do.
