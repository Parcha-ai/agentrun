---
packages: @parcha/pi-durable-disk
kind: docs
---
**The README starts with a path chooser and states how a run on a local directory fails**
- "Choose your path" maps what a reader has (Linux and Node only, Docker and an Archil account, a Linux host with FUSE, an
  app of their own) to the quickstart or section to start with, and points to the examples index.
- The failure table gains the rows for a run on a local directory (`localRun`): a crash or SIGKILL (the next open resumes;
  a command the instance started keeps running, since nothing ends it without a unit cgroup), a power loss (the store
  holds, `work/` may be older), a second process on the machine (refused, exit 76), and another machine reaching the
  directory (unsupported: no fence).
