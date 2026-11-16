---
packages: @parcha/agentrun-computer
kind: fix
---
On a Linux desktop, `apps.launch` with a url into an app that already runs no longer answers "opened" when the launch's launcher ends at once and leaves a process that shows a dialog a moment later. Computerd found the launch's guard by reading the launcher's parent after the start, so a launcher already gone left what it started unseen; it now takes the guard from the start itself, and the call refuses naming the dialog and ends it, as it does for a slower launcher.
