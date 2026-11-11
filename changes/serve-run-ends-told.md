---
packages: @parcha/agentrun-serve
kind: fix
---
The server no longer re-reads a run whose end it has already told. Its run-end follower reads the store every 250 ms, and it used to build the run's notice (its summary, with the run's words redacted) for every ended run among the newest 50 on every read, so each ended run was summarized and redacted four times a second for good. Now the notice is built only for an end not told yet.
