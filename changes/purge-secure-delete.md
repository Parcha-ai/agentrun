---
packages: @parcha/agentrun-serve
kind: feature
---
A purged run's or agent's content no longer stays in the SQLite store's file bytes: every store connection writes with `secure_delete` on, so a deleted or overwritten row's bytes are zeroed in its page, and a purge checkpoints the WAL (`TRUNCATE`) once it commits, so neither `store.sqlite` nor its `-wal` keeps an earlier copy. The checkpoint waits a few milliseconds for another connection, never the store's 10 s busy wait, so it holds up no other request. One another connection holds back is retried once, then logged (the next purge's checkpoint or the server's stop clears it), and never fails the `DELETE`. Postgres is not covered: `VACUUM` only makes a purged row's space reusable, so its bytes stay until a later write overwrites them; `VACUUM FULL` rewrites the table; Postgres's WAL, archived WAL and backups keep the old values for their own lifetimes.
