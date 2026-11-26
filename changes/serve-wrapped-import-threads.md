---
packages: @parcha/agentrun-serve
kind: fix
---
Wrapped's read of the home passes the import an explicit `threads` (the cores less one, at most 8) and a `readAhead` of a quarter of the import worker's heap (512 MiB), instead of taking the import's defaults. So serve's memory for a Wrapped read stays bounded by its own settings when the import's defaults grow.
