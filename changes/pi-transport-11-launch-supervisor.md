---
packages: @parcha/pi-transport
kind: feature
---
`launch`, `launchStatus` and `stopLaunch` (`./home`): keep a program alive in a box whatever happens to the host. A small `sh` supervisor, uploaded with `Box.upload`, restarts the program when it exits (with a restart limit and terminal exit codes), keeps its output to a bounded tail, and reports its phase from a state file (`lost` when its launcher is gone). It needs `sh`, `setsid`, `sed`, `cut`, `awk`, `wc`, `tail`, `date` and `sleep`, and runs on Debian, Alpine and a VM whose init never reaps.
