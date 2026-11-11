---
packages: @parcha/agentrun-serve
kind: fix
---
A Postgres store that holds two answers to one tool call's approval (an approve and a deny that raced before migration 0003) now refuses the server's start in words: the run, the call, its answer commands, and the statement that keeps the first answer and refuses the rest. It showed Postgres's own "could not create unique index" before. Nothing in the store is changed for you; a migration may now ship a `NNNN_name.check.sql` beside it, run first, whose rows refuse the migration.
- Upgrading: nothing to change, unless the server names such a run: run the statement it gives, then start it again.
