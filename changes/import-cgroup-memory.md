---
packages: @parcha/agentrun-import
kind: fix
---
`parseHome`'s default threads and read-ahead now see a memory limit set on an ancestor cgroup (cgroup v2): they take the lowest `memory.max` or `memory.high` from the process's cgroup up to the root (the rule Node applies to the process's own cgroup) when it is below `process.constrainedMemory()`, so a container whose limit sits above the process's own cgroup no longer sizes the pool for the host's memory. The default threads also fit in the room each limited cgroup has left, its limit less its working set (`memory.current` less `memory.stat`'s `inactive_file`), so a 2 GiB container already holding 1 GiB starts fewer workers than an idle one.
