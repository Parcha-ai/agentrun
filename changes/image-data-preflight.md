---
packages: @parcha/agentrun-serve
kind: fix
---
The image stops before it starts the server when its `--data` directory is there but its user can't write it, as with a volume mounted as root's. It prints one line naming the directory, its owner's uid and mode, and the uid it runs as, then exits 1. Before, the server failed later, in the store's setup. A directory not made yet is still the server's to make.
