---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A process that exited and was never reaped (a zombie, as an orphan becomes under a PID 1 that does not reap, such as a container started without an init) is no longer counted as running. `processAlive(pid)` (from `@parcha/agentrun-kernel/host`) reads the process's state on Linux and falls back to `kill(pid, 0)` elsewhere; serve uses it to watch a run's process, so a server that restarts after its run's process died relaunches the run instead of waiting on the zombie forever.
