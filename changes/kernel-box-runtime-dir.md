---
packages: @parcha/agentrun-kernel
kind: fix
---
A boxed session's default socket name that another user took first (a directory, a file, a FIFO, a socket or a link of theirs) is never followed, touched or used, and never fails the session. The session takes its own directory from an earlier run beside it, when one passes every check the default does (this user's own, 0700, not a link, local), or else a fresh one, whose name is held to the 81-byte bound before anything is made. A runtime directory the host names itself is still refused, never replaced.
