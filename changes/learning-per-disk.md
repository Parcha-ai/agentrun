---
packages: @parcha/agentrun-serve
kind: fix
---
Learning is per (agent, disk). A run on a disk its launch names (`archil_disk`) no longer reads, compiles from, replays, audits or serves what the agent learned from runs on another disk, and its promotions and grades are kept apart. Before, every disk shared one learning, so a self-hoster's customers could see each other's traces in a learned workflow.

Upgrading: runs gain a `disk` column, filled from each run's launch (Postgres migration `0023_run_disk.sql`; SQLite store version 15, which the server applies when it opens the store, and a runner waits for that). A run purged before the upgrade has no launch left, so it reads as the default disk's. A run on a launch-named disk now starts with no learning, because the server reads only the default disk's learning folder. A run on the agent's own disk, or on no disk, learns as before.
