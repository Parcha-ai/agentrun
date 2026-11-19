---
packages: @parcha/agentrun-serve
kind: fix
---
A runner of its own started before its server has upgraded the store now stops the same way on SQLite and Postgres: exit code 3, with `The store in <place> is behind this runner: start the server first, which upgrades the store in place, then the runner.` Before, a SQLite runner exited 1 with the store's own message, and one of those messages (native command ownership metadata) was worded differently from the rest. Anything that opens the store as a runner (`agentrun-serve import --dry-run` too) is now told `Start the AgentRun server to <what> before opening a runner. The runner does not upgrade this store.` on either store.
