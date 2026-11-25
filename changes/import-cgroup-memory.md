---
packages: @parcha/agentrun-import
kind: fix
---
`parseHome`'s default threads and read-ahead now see a memory limit set on an ancestor cgroup (cgroup v2): they take the lowest `memory.max` or `memory.high` from the process's cgroup up to the root (the rule Node applies to the process's own cgroup) when it is below `process.constrainedMemory()`, so a container whose limit sits above the process's own cgroup no longer sizes the pool for the host's memory.
