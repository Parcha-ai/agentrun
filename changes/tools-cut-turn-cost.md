---
packages: @parcha/agentrun-serve
kind: fix
---
A codex or opencode turn cut by a park (a host tool call held for a person's approval) is booked at the usage its provider reported. Before, the park closed the session while that answer was still streaming, its booking was lost, and the next claim booked the turn cut at an unknown price, so the run's cost read `unpriced`. A park now waits for the session's paid requests to be booked before it lets the claim go, as a run's end does (bounded; past the bound the turn is booked cut, and the spend cap counts it at its hold).
