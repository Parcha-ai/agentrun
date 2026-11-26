---
packages: @parcha/agentrun-serve
kind: fix
---
A learned workflow call in a run's `workflow_calls` reads `refused` (`usd` 0) only while nothing was booked under its call id. A call whose earlier attempt spent before a crash cut it, and whose rerun was then refused (at the gate, or because a tool one of its call nodes runs was set to deny), now reads `failed` at what it booked, or `usd` null when a request of it has no known cost. Before, it read `refused` at $0, and a run whose calls all read so took the agent's path.
