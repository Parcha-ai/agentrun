---
packages: @parcha/agentrun-serve
kind: fix
---
A data root serves one server at a time, and the server now enforces it instead of the README only saying so. A server takes `<data>/server.lock` (mode 0600) and holds it until it closes. It takes the lock after the checks that only read and refuse, such as agent homes from 0.1.0-beta.26, so a start they refuse still creates nothing. It takes it before anything that writes. A second server on the same root, in another process or in the same one, is refused before it opens a store, adopts a run or binds a port. The CLI exits 1 with one line: `agentrun-serve: another server holds this data root (<data>/server.lock): stop it, or start this one with another --data`. A crashed server's lock is released by the kernel, so the next start reuses the file. `takeServerLock(dataRoot)` and `ServerLockHeldError` are exported.
