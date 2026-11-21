---
packages: @parcha/agentrun-serve
kind: fix
---
A connected SDK agent's learned workflow is promoted only after compile_after checked turns, like a managed agent's, not after one. Each reserved native turn is one row of the check: the agent answers it, the caller's shadow runs the draft, and the server keeps the compared turn on the promotion record (`check.turns`) and waits for the next turn the draft takes. The turn that makes `learning.compile_after` decides once on every turn collected, on the same `agree_min` and `alone_min` bar; a disagreement no longer holds the draft on its own turn, and a turn the backend never completes within an hour is one failed row of the check instead of its decision.
