---
packages: @parcha/agentrun-serve
kind: breaking
---
A run's seed is read with no git in the server process. The server runs the learning script's init, then its read at main (`learn/seed-check.ts` readSeed through `seedFrom`). When a body in the folder is not main's (an uncommitted edit), the seed reads git's objects at that commit, so a run still starts from main's commit and never from the working tree. Workflow drafts come from the folder's snapshot. A skill that holds a tracked link is left out with a one-line warning, and the other skills are laid. The learning script checks its own git floor (2.32): below it, a run starts with nothing learned and the script names the git it found. A link where the script would write is refused in the same words every learning read uses. Deleted from `learning.ts`: the host-git seed reads (`readSkills`, `readWorkflows`, `changedOrder`) and `learningBlocker`. Deleted from `learning-words.ts`: the stop words nothing says any more (`noGit`, `screenDown`, `notReviewed`). The end-of-run turn and propose still run on the server until the runner switch.

Upgrading: nothing to do; the learning folder's layout and snapshot are unchanged.
