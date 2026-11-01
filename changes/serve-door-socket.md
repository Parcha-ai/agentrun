---
packages: @parcha/agentrun-serve
kind: feature
---
serve can launch a run with its door on a unix socket in the run's directory (`doorSocket` on the server's options, off by default; no flag sets it), so a box that shares the run's directory reaches the door too. serve takes a `unix:` door only when its path is inside that run's own directory, with no `.` or `..` part and no link on the way, and the socket itself a socket; the process, heartbeat and lease checks still apply. The timeline's event stream, messages and stops reach a socket door through node:http's `socketPath`; a loopback door is reached as before. A data directory too deep for a socket address keeps the run on loopback, and the log says so (`door_socket_too_long`); the launch never fails for it.
