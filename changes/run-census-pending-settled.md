---
packages: @parcha/agentrun-serve
kind: breaking
---
A run's census (0.1.0-beta.57) no longer keeps a "pending" state. A launch's census is null until a run's end writes one, and 0.1.0-beta.57's Postgres trigger, which marked a launch "pending" when it first held sealed secrets, is gone. Each "pending" left is settled once, as this release reads it: null on a launch still holding its secrets, so its end counts them, and "unscanned" on one an end erased, so its files stay withheld. Postgres does this in migration 0029 `run_launch_census_settle`, and SQLite when the server opens.
- Postgres migration 0029 is marked as breaking runners, so the runner floor rises to 29. A runner from before this release stops at its next floor read (every 10 s) and hands its runs back. A run such a runner ends before that read has no census, and its files read as a run's from before 0.1.0-beta.57 do: cut of the server's values alone.
- A "pending" written after the upgrade, by a server from before this release still running during a rolling deploy, reads as no census this release knows: the run's files are withheld, never read uncut.
