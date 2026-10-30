---
packages: @parcha/agentrun-serve
kind: fix
---
A data root serves one server at a time, and the server now enforces it instead of the README only saying so. A server takes `<data>/server.lock` (mode 0600) before it reads or writes anything else in the data root, and holds it until it closes. A second server on the same root, in another process or in the same one, is refused before it opens a store, adopts a run or binds a port. The CLI exits 1 with one line: `agentrun-serve: another server holds this data root (<data>/server.lock): stop it, or start this one with another --data`. A crashed server's lock is released by the kernel, so the next start reuses the file. `takeServerLock(dataRoot)` and `ServerLockHeldError` are exported.
