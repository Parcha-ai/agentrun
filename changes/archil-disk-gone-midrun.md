---
packages: @parcha/agentrun-serve
kind: fix
---
A disk removed at Archil while a run is on it now fails that run's next disk call as the disk being gone (`UNAVAILABLE`, in Archil's words), not as a missing file.
