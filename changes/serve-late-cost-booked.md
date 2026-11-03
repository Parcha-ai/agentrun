---
packages: @parcha/agentrun-serve
kind: fix
---
A claude-agent or codex run's cost no longer reads unknown until the run is opened again when bookings come in late or out of order. The proxy books a response when its stream closes, which can be after the harness has its answer, after its turn has ended, and after a later request's booking.
- A late cost for a request written at unknown cost goes on the root as soon as it comes in, wherever it sits among the costs still to write. Before, it was written only when it was the oldest of them, so behind a later request's cost it waited for the next open.
- A cost that comes in with no turn running is written then. Before, a request still unbooked at its turn's end, whose cost came only after the turn, had no root entry until the next open.
Each request is still written once, and each cost once. The cap reads the session's own bookings, as before.
