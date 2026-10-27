---
packages: @parcha/pi-git-remote
kind: feature
---
`commitTo(branch, { ..., mergeParent })` makes a merge commit: its parents are the base and `mergeParent`, and its tree is the base's with `files` applied, never the merged commit's tree. A host that curates a run's branch into `main` records the run as merged while choosing what lands; `git revert -m 1` undoes it.
