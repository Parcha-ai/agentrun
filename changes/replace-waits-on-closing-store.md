---
packages: @parcha/agentrun-serve
kind: fix
---
A server started while the one it replaces is still closing its store no longer exits with "database is locked". Its check for an earlier version's store read the store file before taking the owner lock, with no wait, so a read that landed during the old server's last checkpoint failed and the new server exited 1. The check now waits for that lock as long as the store's own connection does (10 s by default).
