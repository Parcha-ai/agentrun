---
packages: @parcha/agentrun-serve
kind: fix
---
Serve's per-process spend engine in `cap.ts` is gone: the run's one ledger (the kernel cap) holds every model request and paid call, so nothing reads the process-wide spend any more. `cap.ts` keeps what the store readers and the refusal words use: the cap modes, `spentFrom`, `meterFiguresFrom`, `money` and the refusal code. No public export changes.
