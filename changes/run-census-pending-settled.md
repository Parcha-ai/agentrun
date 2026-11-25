---
packages: @parcha/agentrun-serve
kind: breaking
---
A run's census (0.1.0-beta.57) no longer keeps a "pending" state. A launch's census is null until a run's end writes one, and 0.1.0-beta.57's Postgres trigger, which marked a launch "pending" when it first held sealed secrets, is gone. Each "pending" left is settled once, as this release reads it: null on a launch still holding its secrets, so its end counts them, and "unscanned" on one an end erased, so its files stay withheld. Postgres does this in migration 0029 `run_launch_census_settle`, and SQLite at the first server open of this release.
- One narrower rule stays in the store, on Postgres and SQLite alike: an update that erases a launch's sealed secrets and leaves its census null writes "unscanned". This release's ends always write a census when they erase, so only a runner of 0.1.0-beta.51 to beta.56 (which ends with none) does that, and that run's files are withheld, never read cut of the server's values alone. A beta.57 runner writes its own census.
- Postgres migration 0029 is marked as breaking runners, so the runner floor rises to 29. A runner from before this release stops at its next floor read (every 10 s), lets each busy run go on to its end for up to its drain timeout, and exits. On SQLite such a runner is never stopped. On both, the rule above covers the runs it ends.
- A "pending" written after the upgrade, by a 0.1.0-beta.57 server still running during a rolling deploy, reads as no census this release knows: the run's files are withheld, live and after its end, never read uncut.
