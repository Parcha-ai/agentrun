---
packages: repo
kind: fix
---
The web example's server reads the agent home again whenever the store's head commit moves. It keyed its cache on the store file's mtime and size, which a commit can leave as they were (the size does not move, and a write inside one tick of the filesystem's clock keeps the mtime), so a run started right after the server's last read could answer 404 until the next write.
