---
packages: @parcha/agentrun-harness
kind: fix
---
A supervised demo run's tool-box receipts are the supervisor's again (RECORDING.md 3.1: the supervisor writes every live host line, and a process writes none). A `box.receipt` for a box a demo's provider made went through the run process's recorder, which has no supervisor, so the line carried an event-level `gen` and its own `seq`: the viewer's format check flagged every one. The supervisor now sets `HOST_LINES=supervisor` for its processes when it owns the box ids directory; such a process (`supervisedChild(env)`, exported from the harness's boxes module) keeps each box's end and the process that made it in the box's file and writes no line, and the supervisor writes each receipt once from that directory, with the process in `data.gen`. A run whose ids directory the supervisor does not own keeps the process's receipt.
