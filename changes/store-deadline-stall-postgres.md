---
packages: @parcha/agentrun-serve
kind: fix
---
On a Postgres store, a write held up by the server process (its event loop busy with other work) no longer rolls back when the transaction itself was fine: its deadline, counted from the transaction's begin, counts only the time the process could run, as on SQLite. A lease's renew, whose deadline runs from its call, still counts the wall clock.
A pause longer than the database's idle-in-transaction timeout (the deadline plus 5 s) still ends the session at the database's end, which rolls the transaction back. The write now answers 409 `home_busy`, which is safe to retry, never a 500. A pause that ends just before the commit is credited to the commit's time too.
- Upgrading: nothing to change.
