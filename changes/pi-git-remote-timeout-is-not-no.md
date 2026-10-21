---
packages: @parcha/pi-git-remote
kind: fix
---
A git that times out, or fails in any other way, while the repository asks whether a commit exists or whether one commit is an ancestor of another is now a `git` error. It is no longer read as "no". Read as "no", a `merge-base` that timed out while `commitTo` picked a branch's tip made the remote's tip win over a local commit not yet pushed. The write then built on the remote's tip and moved the branch off the local commit, so that commit was lost. Exit 1 stays the only "no". A `rev-parse` that timed out reads as a git failure too, not as a missing ref.
