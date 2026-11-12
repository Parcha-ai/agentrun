---
packages: @parcha/agentrun-serve
kind: fix
---
A run's pull request checkout (`checkout: pull_request`) no longer leaves Git's maintenance running in `repo/` after the fetch. Git 2.47 and later run the maintenance a fetch starts in the background, so it could still be writing in `repo/.git` when the run began, and the checkout's removal when the claim let go could fail with "Directory not empty" and leave the folder behind. The server's fetches now start no maintenance.
