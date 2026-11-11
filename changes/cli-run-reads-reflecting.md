---
packages: @parcha/agentrun-serve
kind: fix
---
A learning run on a CLI harness (claude-agent, codex, opencode) now reads `learning.state: "reflecting"` while its end-of-run turn runs, as a pi run does, and its Timeline shows the turn's "Looking back on this run." row from the moment the turn is asked, a Timeline stream already open included. Before, the run read `seeded` through the whole turn and went straight to `proposed`, so for the length of the turn (about 10 seconds on a live model) nothing said it was looking back.
Upgrading: nothing to do.
