---
packages: @parcha/agentrun-serve
kind: fix
---
A data root serves one server again, whatever its store. Since the switch to the one store, a server took only its store's owner lock, so two servers on one data root, each on a store of its own (two Postgres schemas, or SQLite and Postgres), both started and shared what the server writes beside its store (its token, its seal key, uploads, harness installs). A server now also takes `<data>/server.lock` once it holds its store, waits up to 5 s for a server that is still exiting, and otherwise exits 1 with `another server holds this data root`. `serveWithRunner(options)` is exported: a server and a runner beside it in one process, as the CLI's start composes them, for a launcher that starts serve in-process (a server alone leaves every run queued).
