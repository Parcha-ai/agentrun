---
packages: @parcha/agentrun-serve
kind: fix
---
A run that sends no model key (one held because its model can't run, one on a `--faux` start, or one pinned to the faux model) no longer reads any saved model key or the Claude login for the run at its start. A held run with decision nodes now gets its judge's key when that key is TypeSafe's or a model gateway's; before, its judge failed for want of it. Where each run runs as a user of its own and the Claude login is this machine's own (`~/.claude`), these runs are no longer refused at their start for a login they never use. Where runs run as the runner's own user (`AGENTRUN_RUN_USER=same`), such a run now runs as a process of its own instead of inside the runner on the login.
