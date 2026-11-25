---
packages: repo
kind: ci
---
The serve test helper's `raw()` runs its SQLite statements on a worker thread, so a write that waits on the database lock no longer blocks the event loop the in-process server needs to commit, which removes a "database is locked" flake. Test-only; no shipped code changes.
