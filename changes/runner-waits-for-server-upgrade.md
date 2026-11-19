---
packages: @parcha/agentrun-serve
kind: fix
---
A runner of its own started on a Postgres store before its server has upgraded it now says what to do: start the server first, which upgrades the store in place, then the runner. Before, it said to run a runner of the same release as the server. `agentrun-serve import --dry-run` on such a store said to start on a new, empty data folder, and now says to start the server first too: on Postgres the server of this release upgrades an earlier store in place at its start. The known issue beta.45 and beta.46 shipped about this advice no longer applies. A server's own refusal of a SQLite store an earlier release set up is unchanged.
