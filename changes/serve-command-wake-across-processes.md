---
packages: @parcha/agentrun-serve
kind: feature
---
A command row written in one process now wakes its reader in another, so a computer call to a runner in its own process answers in about 10 ms on SQLite and 20 to 30 ms on Postgres, where it used to wait out both polls (about 505 ms). On Postgres the store sends a NOTIFY on its schema's channel after each command write and take, and a store that watches its commands holds one more connection of its own for the LISTEN (`agentrun-store-wake:<schema>`). On SQLite the processes on one data directory share a small wake file beside the store's file, `store.sqlite.wake`. A wake is a hint: a lost one costs only the poll.
