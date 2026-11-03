---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose follow-up turn ends without showing an answer now ends completed, its answer the earlier one. The Claude CLI's `/compact` is one such turn: a summary request and no text. Before, the run sat `working`/`idle` until another message came, because serve ended a run only when its newest row was an answer. Now the person's newest message also ends the run once the turn is over and, in the run's entries, an answer that ended its request (`stop`) follows that message. That follows from the entries' own order, never from when the door said idle. A follow-up placed while a turn works comes after that turn's answer, so it is still waited for, on every harness.
