---
packages: @parcha/agentrun-kernel
kind: fix
---
A boxed session's default socket directory goes under `/tmp` when the OS's temp directory has an ancestor only its owner may search (mode 700, as macOS's per-user temp directory or `XDG_RUNTIME_DIR` is), so the box can reach the sockets bound from it. A temp directory every caller can pass through is used as before. `traversable` and `socketBase` say which.
