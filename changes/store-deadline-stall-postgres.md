---
packages: @parcha/agentrun-serve
kind: fix
---
On a Postgres store, a write held up by the server process (its event loop busy with other work) no longer rolls back when the transaction itself was fine: its deadline, counted from the transaction's begin, counts only the time the process could run, as on SQLite. A lease's renew, whose deadline runs from its call, still counts the wall clock.
- Upgrading: nothing to change.
