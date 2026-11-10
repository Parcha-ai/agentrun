---
packages: @parcha/agentrun-serve
kind: fix
---
A deployment on Postgres is one store. The server, the runner beside it and `import` now open the store `AGENTRUN_STORE_URL` names (Postgres, in the schema `AGENTRUN_STORE_SCHEMA` names), as a runner started apart already did; before, they opened SQLite in the data directory whatever the URL said, so a `--no-runner` server's runs were never claimed by runners on Postgres. The server holds the schema's owner lock: a second server on it is refused, and so is `import` while a server runs. `GET /v2/health` reads the store the server opened, so a server on Postgres answers 200 (it answered 503 `does_not_open`, and a compose's runners waiting on its health never started). Upgrading: nothing to do; with no `AGENTRUN_STORE_URL` the store is SQLite in the data directory, as before.
A Postgres store no longer hangs, loses a runner its claims, or stops the process when its database goes silent or a connection dies:
- A transaction is bounded from before its begin; a connection that stops answering is let go at the deadline. A commit whose answer never comes fails with `Unanswered` (its outcome unknown), never with `StoreDeadline` (nothing written).
- A claim renew, connect to commit, is bounded by 8 s from its call, so one on a silent connection fails before the runner's next renew, which opens a fresh connection.
- A statement outside a transaction is bounded too; a backend that dies under a call fails that call, never the process.
- TCP keepalives start at 10 s on both ends, and a transaction whose client vanished lets its row locks go once idle 5 s past its deadline.
- A malformed store URL is refused without its text, which may hold a password.
