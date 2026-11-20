---
packages: @parcha/agentrun-serve
kind: feature
---
A purged run's or agent's content no longer stays in the SQLite store's file bytes: every store connection writes with `secure_delete` on, so a deleted or overwritten row's bytes are zeroed in its page, and a purge checkpoints the WAL (`TRUNCATE`) once it commits, so neither `store.sqlite` nor its `-wal` keeps an earlier copy. A checkpoint another connection holds back is retried once, then logged (the next purge's checkpoint or the server's stop clears it), and never fails the `DELETE`. On Postgres a purged row's bytes stay in its dead tuples until VACUUM (autovacuum, or `VACUUM` on the touched tables by hand).
