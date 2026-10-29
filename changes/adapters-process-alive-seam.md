---
packages: @parcha/agentrun-adapters
kind: fix
---
`processAlive` reads a zombie as gone when it is passed straight to an array method (`pids.filter(processAlive)`). It took its second argument, the index there, as the test seam that reads `/proc/<pid>/stat`, failed calling it, and fell back to `kill(pid, 0)`, which still finds a zombie. A second argument that is not a function is now ignored.
