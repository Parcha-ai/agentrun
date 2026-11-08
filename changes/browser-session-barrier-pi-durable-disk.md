---
packages: @parcha/pi-durable-disk
kind: fix
---
`BARRIERS` names `browserSessionOpen` (active, its proof a box-loss test: a browser session's open written and synced before the vendor creates it), and NORMAL's precondition `browserSessionBarrier` is done: the durable unit is the session open; per-call holds are in-process reservations re-derived at reopen, by design.
