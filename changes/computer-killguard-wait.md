---
packages: @parcha/agentrun-computer
kind: fix
---
A run the daemon has to end with SIGKILL (its guard stalled or outlived its grace) returns only once every process under the guard has ended. SIGKILL lands asynchronously, so `exec.run` could report a timeout or a cancel while a process it had just killed still ran for a moment. The daemon now waits, bounded at 10 seconds, until each such process is gone or a zombie, telling a reused pid apart by its start time, and fails with an error naming any process still running after that.
