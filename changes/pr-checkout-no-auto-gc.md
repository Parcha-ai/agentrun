---
packages: @parcha/agentrun-serve
kind: fix
---
A run's pull request checkout is removed cleanly at the run's end: its fetches run with git's auto maintenance off, so no detached gc writes into `repo/.git/objects` while the removal deletes it (it failed with "Directory not empty").
