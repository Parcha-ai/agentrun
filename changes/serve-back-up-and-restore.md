---
packages: @parcha/agentrun-serve
kind: docs
---
The README has a "Back up and restore" section. Stop the server and its runners, then copy the data directory, and on Postgres `pg_dump` the store's schema too. Keep the seal key with the copy, or keep `AGENTRUN_SEAL_KEY` safe when you set it. A restore comes back with the same token, password, agents, runs and triggers, and its sealed secrets open. Losing the seal key loses every sealed secret: a restore with a missing or different key does not start, and the section quotes what the server says.
