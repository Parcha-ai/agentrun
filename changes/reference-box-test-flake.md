---
packages: repo
kind: fix
---
The reference entry's boxes test no longer flakes under load: when the demo plans to lose the install box, the install tool's first command waits until it is killed (no timer), so the loss always lands mid-command and the second box always runs; before, a slow loss let the first command finish and the second box was never made.
