---
packages: repo
kind: ci
---
The test that damages a run's box ids directory before the supervisor's final pass now damages it when the run's process has exited, through a local place of the test's own, instead of from a file watcher. The watcher wrote the damaged file once `box-2.json` read `ended`, but nothing ordered its callback before the supervisor's reads: a supervisor pass could mark that receipt `written` first, so the watcher never wrote the file, or the file could land after the final pass. Either way the run succeeded and the test failed with "Missing expected rejection". The supervisor waits for the place's exit before it reads the directory again, so the damage now always lands after the process's last write and before the final pass. The reference demo's test `run()` takes demo options of a test's own as a fifth argument. Test-only: the harness is unchanged.
