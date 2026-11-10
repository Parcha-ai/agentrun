---
packages: repo
kind: fix
---
A working run's header shows its cost as it stands: it follows each timeline page's `cost`, never the run's first read, which can be older than every priced request ("$0.0000 est." beside a Timeline that says otherwise). An ended run's cost is still the run's own read at its end.
