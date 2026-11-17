---
packages: @parcha/agentrun-serve
kind: fix
---
The server starts on a data directory that is a mounted disk. Its first-start check for an earlier version's files stopped with `EACCES` on the disk's `lost+found`, which belongs to root with mode 700. It now skips any path it can't look into. An earlier version wrote its files as the server's own user, so they can't be hiding there.
