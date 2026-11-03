---
packages: @parcha/agentrun-dsl, @parcha/pi-durable-disk
kind: ci
---
dsl's test of a poll wait with a fraction of a millisecond now fakes the clock and the timers the recovery driver waits on: after 200 ms of a 200.5 ms wait the next check has not started, and after 201 ms it has. Before, it measured the gap between two checks on `performance.now()` and wanted at least 199 ms, but Node can fire a timer a millisecond or two early on a loaded machine, so the test failed although the wait was right. pi-durable-disk's scripted `/proc` and `ps` tables now use pids from 9,004,200 up, past any pid Linux or macOS hands out. Before, they used pids such as 4300 and 4301, and when the test process itself had one of them, the reaper rightly refused to signal what it took for its own process or group, and the tests that expected those kills failed.
