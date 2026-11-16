---
packages: @parcha/agentrun-serve
kind: fix
---
On Postgres, a store call that waits for one of its pool's connections while every one is in use now waits up to a write's deadline (10 s, `poolWaitMs`), not the 4 s connect timeout. A runner of 300 loops on a database a few milliseconds away queues its loops' commits behind one another for seconds, and dozens of its runs failed for good with "no connection to the store's Postgres ... it does not answer, or every connection of this store is in use" while the database answered. A new connection's connect and startup keep the 4 s bound (`connectTimeoutMs`), so a database that does not answer still fails fast, now in words that say only that. A wait past the pool's bound fails in words of its own: "no connection of the store's Postgres at ... came free within 10000 ms: all 10 of this store's connections stayed in use".
