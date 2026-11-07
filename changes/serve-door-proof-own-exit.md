---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose process fails at its start is no longer started again when its door's proof fails while the process is still exiting. The server now gives a process whose door fails its proof up to 2 seconds to exit on its own before it stops it: a process that exits with its own error fails the run once, with that error, and is never counted as one that did not open its run. A process still alive after those 2 seconds is stopped and its run opened again, as before (#1820).
