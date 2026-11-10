---
packages: @parcha/agentrun-serve
kind: feature
---
A server on a Postgres store deploys without a gap. Started while another server holds the schema, it waits up to 2 minutes for the old one to let go, saying so once, instead of exiting at once with "another server holds the store". A server whose owner-lock connection is lost (a failover, a database restart) refuses calls while it takes the lock back on a fresh connection, then serves again. If another server took the schema meanwhile, or the lock can't be taken back within 2 minutes, it exits 1 so its platform restarts it, rather than answering 503 for as long as it runs.
