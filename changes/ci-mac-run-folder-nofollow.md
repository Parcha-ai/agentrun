---
packages: repo
kind: ci
---
The macOS job runs the run folder's path-resolving tests on the Mac's own kernel: each open refuses a link anywhere on the way with O_NOFOLLOW_ANY, which Linux CI only stands in for by a walk through /proc.
