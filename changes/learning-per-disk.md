---
packages: @parcha/agentrun-serve
kind: fix
---
A run on a disk its launch names (`archil_disk`) learns nothing: it starts with no seed, no learned corrections and no learned workflow, and every learning read of the agent's runs (a compile's traces and its `compile_after` count, a check's replays, an audit's draw, the money rule, the cost page's ledger) skips it. Before, such a run read and fed the one learning of its agent, so a self-hoster's customers could see each other's traces in a learned workflow. A later change that lets named disks learn adds a per-disk key to the learning records.

Upgrading: runs gain a `disk` column, filled from each run's launch (Postgres migration `0026_run_disk.sql`; SQLite store version 15, which the server applies when it opens the store, and a runner waits for that). A run purged before the upgrade has no launch left, so it reads as the default disk's. A run on the agent's own disk, or on no disk, learns as before.
