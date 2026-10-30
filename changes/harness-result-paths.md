---
packages: @parcha/agentrun-harness
kind: fix
---
A run's result hands back the paths a program opens as they are. The scrub that takes the user name and the home out of a recording (a path segment named after the user becomes `[user]`, the home `~`) also ran over the value `demo()` returns and the line `--json` prints, so a run whose directory or recording sat under a directory named after the user, or under the home (`TMPDIR=~/tmp`), handed back a `dir` and `recording` that did not exist. Those two fields now come from the run itself; everything else in the result, the printed summary, and the recording keep the scrub.
