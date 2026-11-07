---
packages: @parcha/agentrun-serve
kind: fix
---
A write or edit that waits for approval no longer shows a "Saved <path>" row on the Timeline: not while it waits, not after a Deny or a withdrawal, and not after an Allow, whose resume row ("AgentRun: write ran once you allowed it") says it ran. The note a person types with a Deny is now on the resume row's summary: "AgentRun: write was refused: you declined it: <the note's first line>", redacted whole with the run's redactor, then cut to 200 characters. A message that declined the call adds nothing there, as it shows as the person's own row. Upgrading: nothing to do.
