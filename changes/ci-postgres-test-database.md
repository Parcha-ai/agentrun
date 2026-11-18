---
packages: @parcha/agentrun-serve
kind: ci
---
CI's store-on-Postgres job runs the database `test/pg/compose.yaml` runs locally: its data on tmpfs, `fsync` and `full_page_writes` off. With a schema per test, a checkpoint on the runner's disk synced 80k-150k files over 90-180 s, and a commit behind it went past the store's 10 s deadline. A lock wait past 1 s is now logged with its holder.
