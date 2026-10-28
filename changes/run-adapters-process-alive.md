---
packages: @parcha/agentrun-adapters
kind: feature
---
`processAlive(pid)` from `@parcha/agentrun-adapters/host` says whether a process is running. A zombie, which has exited but whose parent has not reaped it, is not running, even though `kill(pid, 0)` still finds it. That happens to every orphan under a PID 1 that does not reap, such as a container started without an init. On Linux, the answer comes from the state in `/proc/<pid>/stat`; elsewhere, from `kill(pid, 0)`.
