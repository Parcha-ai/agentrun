---
packages: @parcha/agentrun-serve
kind: fix
---
On macOS (and any host that isn't Linux), a run's folder can no longer be used to reach host files through a symlink swapped in mid-walk. The end-of-run sweep removes a link itself, never what it points at, and a read, a file GET or grep refuses a file whose real path leaves the run folder. On Linux, behaviour is unchanged (it was already safe through O_NOFOLLOW and /proc/self/fd).
