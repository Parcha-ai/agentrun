---
packages: @parcha/pi-durable-disk
kind: docs
---
**The README starts with a path chooser and states how a run on a local directory fails**
- "Choose your path" maps what a reader has (Linux and Node only, Docker and an Archil account, a Linux host with FUSE, an
  app of their own) to the quickstart or section to start with, and points to the examples index.
- The failure table gains the rows for a run on a local directory (`localRun`): a crash or SIGKILL (the next open ends
  the commands the killed instance left running, then resumes), a power loss (the store holds, `work/` may be older), a
  second process on the machine (refused, exit 76), a process of the killed incarnation that will not die (the open is
  refused, exit 76, naming it), and another machine reaching the directory (unsupported: no fence).
  The layout names a local run's `commands/`.
