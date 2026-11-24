---
packages: @parcha/agentrun-kernel
kind: fix
---
The parent-watch shim (`parentWatched` where `setpriv --pdeathsig` is not available: macOS, or Linux without it) kills its child with SIGKILL when the child is still running 2 s after a TERM the shim passed on. A host that ends a watched child sends TERM and later SIGKILL; that SIGKILL reached the shim alone, so a child that ignored the TERM, or took longer to exit, ran on with no watch while its host lived. INT and HUP still pass on with nothing after them. A session machine kills its child's process group with SIGKILL, which reaches the child itself, so a session's CLI is ended as before.
