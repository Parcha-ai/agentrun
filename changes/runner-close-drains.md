---
packages: @parcha/agentrun-serve
kind: feature
---
A runner's close drains: `startRunner`'s `drainMs` lets each run it holds go on to its own end (an answer, a park, a person's stop) for up to that long before it stops the rest where they resume, so a turn in flight finishes and is kept instead of being cut and sent again, paid twice, on the next start. Nothing is claimed once the close begins; claims are renewed and a run's commands (a person's stop) still reach it meanwhile. The default, 0, stops every run at once as before.
