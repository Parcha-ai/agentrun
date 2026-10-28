---
packages: @parcha/pi-git-remote
kind: feature
---
`deleteBranch(branch, expected)` deletes a branch on the remote and in the handle, only while the remote holds it at `expected` (a full sha), through a push with a lease. A branch that moved past it is a `conflict` and stays, and a branch already gone answers `false`. A host that has merged a run's branch deletes it this way.
