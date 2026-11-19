---
packages: @parcha/agentrun-serve
kind: fix
---
A runner started before its server has upgraded the store now stops with exit 3 on SQLite and Postgres alike: `The store in <place> is behind this runner: start the server first, which upgrades the store in place, then the runner.` Before, a Postgres runner said to run a runner of the server's release, and a SQLite runner exited 1 with the store's own words. `agentrun-serve import --dry-run` on such a store now says to start the server first too, not to start on a new, empty data folder. The known issue beta.45 and beta.46 shipped about this no longer applies.
